// placementMath.js — PURE placement geometry for the Design Studio compositor.
// No I/O, no React: everything here is testable math shared by CompositorCanvas
// (slice 2, interaction) and the mockup exporter (slice 3, canvas rasterization).
//
// COORDINATE MODEL (cm-first — LOCKED strategy):
// A placement lives in PHYSICAL MILLIMETRES relative to the print area's top-left:
//   { xMm, yMm, wMm }
// Height is always DERIVED from the artwork's aspect ratio (placementHeightMm) —
// artwork never distorts. Millimetres are the source of truth; the UI formats them
// as centimetres (formatCm) and the canvas converts to screen px via pxPerMm().
// Storing mm (not viewBox px, not %) means the SAME placement re-renders correctly
// when the provisional SVG flats are replaced by the real printshop garment photos
// (whose px geometry will differ but whose physical print area is identical).
import { effectiveDpiFor } from '../../../utils/podValidation';

// Smallest allowed artwork width. Below ~2 cm a chest print is a production
// mistake, and the resize handle becomes ungrabbable.
export const MIN_ART_WIDTH_MM = 20;

// Snap distance in SCREEN pixels — converted to mm per render scale by the canvas,
// so snapping "feels" identical whatever size the canvas renders at.
export const SNAP_SCREEN_PX = 6;

// Rotation is a SMALL-ADJUSTMENT knob (chest prints don't spin) — hard cap.
export const MAX_ROTATION_DEG = 30;

const rad = (deg) => (deg * Math.PI) / 180;

/** Axis-aligned bounding box of a w×h rect rotated deg° around its centre. */
const rotatedAabb = (w, h, deg) => {
  const c = Math.abs(Math.cos(rad(deg)));
  const s = Math.abs(Math.sin(rad(deg)));
  return { w: w * c + h * s, h: w * s + h * c };
};

/** Clamp a rotation to the allowed small-adjustment range (0 for nullish). */
export const clampRotationDeg = (deg) =>
  Math.max(-MAX_ROTATION_DEG, Math.min(MAX_ROTATION_DEG, Number(deg) || 0));

/** Artwork aspect ratio (height/width) from its source pixels, or null if unknown
 *  (PDF/SVG/TIFF originals have sourceWidthPx/sourceHeightPx = null). */
export const artworkAspect = (artwork) => {
  const w = artwork?.sourceWidthPx;
  const h = artwork?.sourceHeightPx;
  return w > 0 && h > 0 ? h / w : null;
};

/** True when an artwork can be composed on the canvas at all: needs a raster
 *  preview to draw AND known source dims for the mm/DPI math. */
export const isComposable = (artwork) =>
  Boolean(artwork?.previewUrl) && artworkAspect(artwork) !== null;

/** viewBox-px per physical mm for a template slot, per axis. The template's
 *  printAreas (px) and printAreaMm (mm) describe the same physical region, so this
 *  is the bridge between placement mm and on-screen geometry. Null if the template
 *  doesn't define the slot. */
export const pxPerMm = (template, slot) => {
  const rect = template?.printAreas?.[slot];
  const mm = template?.printAreaMm?.[slot];
  if (!rect || !mm || !(mm.w > 0) || !(mm.h > 0)) return null;
  return { x: rect.w / mm.w, y: rect.h / mm.h };
};

/** Derived physical height of a placement (mm). */
export const placementHeightMm = (placement, artwork) => {
  const a = artworkAspect(artwork);
  return a && placement ? placement.wMm * a : 0;
};

/** The widest this artwork can be placed ANYWHERE in the slot's print area at a
 *  given rotation (mm): the ROTATED bounding box must fit the area. At 0° this
 *  is the classic min(areaW, areaH/aspect). */
export const maxWidthForRotationMm = (template, slot, artwork, rotationDeg = 0) => {
  const mm = template?.printAreaMm?.[slot];
  const a = artworkAspect(artwork);
  if (!mm || !a) return 0;
  const c = Math.abs(Math.cos(rad(rotationDeg)));
  const s = Math.abs(Math.sin(rad(rotationDeg)));
  return Math.min(mm.w / (c + a * s), mm.h / (s + a * c));
};

/** The widest this artwork can be placed ANYWHERE in the slot's print area (mm),
 *  unrotated: limited by area width or by height via the aspect ratio. */
export const maxWidthMm = (template, slot, artwork) =>
  maxWidthForRotationMm(template, slot, artwork, 0);

/** The widest this artwork may print at ≥ minDpi (mm): the HARD resolution cap
 *  (docs/POD_PRINT_SPEC.md — the studio may not scale past the 300 DPI floor).
 *  Infinity when unknowable (no dims / no threshold) so min() ignores it.
 *  NOT redundant with the upload gate: the gate runs against the artwork's OWN
 *  profile area (a cap-gated 70×50 file passes at tiny pixel counts), but the
 *  studio lets any ready artwork onto any template — so EVERY geometry path
 *  (canvas, strip, rasterizer, publish readouts) must apply this cap or the
 *  mockup and the printed size diverge. */
export const maxWidthForDpiMm = (artwork, minDpi) => {
  const w = artwork?.sourceWidthPx;
  return w > 0 && minDpi > 0 ? (w / minDpi) * 25.4 : Infinity;
};

/**
 * Pocket position support: 'pocket' is a FIXED-SIZE slot at a discrete position
 * (left/center/right, wearer's perspective — printer confirmed 2026-07-27). A
 * template stores the LEFT rect in printAreas.pocket plus per-position x offsets
 * in pocketPositions ({ left:{x}, center:{x}, right:{x} }, same y/w/h). This
 * returns the template with the pocket rect moved to `position` — ONE derivation
 * point in DesignStudio; canvas/strip/rasterizer stay position-agnostic.
 */
export const templateWithPocketPosition = (template, position) => {
  const pocket = template?.printAreas?.pocket;
  const x = template?.pocketPositions?.[position]?.x;
  if (!pocket || x == null || x === pocket.x) return template;
  return {
    ...template,
    printAreas: { ...template.printAreas, pocket: { ...pocket, x } },
  };
};

/** The widest the artwork can grow WITHOUT moving, anchored at its current
 *  top-left (used while resizing so the artwork never slides during a resize). */
export const maxWidthAtMm = (placement, template, slot, artwork) => {
  const mm = template?.printAreaMm?.[slot];
  const a = artworkAspect(artwork);
  if (!mm || !a || !placement) return 0;
  return Math.min(mm.w - placement.xMm, (mm.h - placement.yMm) / a);
};

const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi < lo ? lo : hi);

/**
 * Clamp a placement fully inside the slot's print area (the safe zone — artwork
 * may never cross it; that is the "inga tryck-överraskningar" contract). Rotation
 * is clamped first, then width (against the rotation-aware max — the ROTATED
 * bounding box must fit), then position with the rotated box's margins: a tilted
 * motif's corners can never poke outside the area. Corner case: if the area is so
 * small that MIN_ART_WIDTH_MM doesn't fit, the max wins over the min.
 */
export const clampPlacement = (placement, template, slot, artwork, minDpi = null) => {
  const mm = template?.printAreaMm?.[slot];
  const a = artworkAspect(artwork);
  if (!mm || !a || !placement) return placement;
  const rotationDeg = clampRotationDeg(placement.rotationDeg);
  const wMax = Math.min(
    maxWidthForRotationMm(template, slot, artwork, rotationDeg),
    maxWidthForDpiMm(artwork, minDpi) // hard DPI floor — never scale into blur
  );
  const wMm = clampNum(placement.wMm, Math.min(MIN_ART_WIDTH_MM, wMax), wMax);
  const hMm = wMm * a;
  const aabb = rotatedAabb(wMm, hMm, rotationDeg);
  const marginX = (aabb.w - wMm) / 2;
  const marginY = (aabb.h - hMm) / 2;
  return {
    xMm: clampNum(placement.xMm, marginX, mm.w - wMm - marginX),
    yMm: clampNum(placement.yMm, marginY, mm.h - hMm - marginY),
    wMm,
    rotationDeg,
  };
};

/**
 * Default placement for a slot: 70% of the print-area width (capped so the height
 * fits, floored at the minimum), horizontally CENTRED, top at 10% of the area
 * height (chest prints sit high — vertically centring a chest print is one of the
 * classic incumbent placement surprises). Returns null when the artwork can't be
 * composed. Slice 3 uses this same function for slots the seller never touched.
 */
export const defaultPlacement = (template, slot, artwork, minDpi = null) => {
  const mm = template?.printAreaMm?.[slot];
  const a = artworkAspect(artwork);
  if (!mm || !a) return null;
  const wMax = Math.min(maxWidthMm(template, slot, artwork), maxWidthForDpiMm(artwork, minDpi));
  if (!(wMax > 0)) return null;
  const wMm = clampNum(mm.w * 0.7, Math.min(MIN_ART_WIDTH_MM, wMax), wMax);
  const hMm = wMm * a;
  return {
    xMm: (mm.w - wMm) / 2,
    yMm: Math.min(mm.h * 0.1, mm.h - hMm),
    wMm,
    rotationDeg: 0,
  };
};

/**
 * Placement for LOCKED slots (pocket — POD_PRINT_SPEC: fixed 100×100 area,
 * discrete position, no free placement): the motif fills the area as large as
 * aspect + DPI allow (contain) and centres on both axes. Deterministic — the
 * canvas, the mockup renderer and publish all derive the SAME rect from it.
 */
export const containPlacement = (template, slot, artwork, minDpi = null) => {
  const mm = template?.printAreaMm?.[slot];
  const a = artworkAspect(artwork);
  if (!mm || !a) return null;
  const wMax = Math.min(maxWidthMm(template, slot, artwork), maxWidthForDpiMm(artwork, minDpi));
  if (!(wMax > 0)) return null;
  const hMm = wMax * a;
  return { xMm: (mm.w - wMax) / 2, yMm: (mm.h - hMm) / 2, wMm: wMax, rotationDeg: 0 };
};

/**
 * Centre-snap during drag: if the artwork's centre is within thresholdMm of the
 * print area's centre on an axis, snap that axis exactly. Returns the (possibly
 * moved) placement + per-axis flags so the canvas can draw the guide lines.
 */
export const snapPlacement = (placement, template, slot, artwork, thresholdMm) => {
  const mm = template?.printAreaMm?.[slot];
  const a = artworkAspect(artwork);
  if (!mm || !a || !placement) return { placement, snappedX: false, snappedY: false };
  const hMm = placement.wMm * a;
  const centeredX = (mm.w - placement.wMm) / 2;
  const centeredY = (mm.h - hMm) / 2;
  const snappedX = Math.abs(placement.xMm - centeredX) <= thresholdMm;
  const snappedY = Math.abs(placement.yMm - centeredY) <= thresholdMm;
  return {
    placement: {
      ...placement,
      xMm: snappedX ? centeredX : placement.xMm,
      yMm: snappedY ? centeredY : placement.yMm,
    },
    snappedX,
    snappedY,
  };
};

/** A placement's UNROTATED rect in the garment's viewBox px (mm → px via the
 *  template's px↔mm map, offset by the print-area origin). Renderers apply
 *  rotationDeg around this rect's CENTRE themselves (CSS transform / ctx.rotate /
 *  sprite.rotation). Shared by the interactive canvas, the strip thumbnails and
 *  the rasterizers — one source of truth. Null when unresolvable. */
export const placementToViewBoxRect = (placement, template, slot, artwork) => {
  const rect = template?.printAreas?.[slot];
  const ppm = pxPerMm(template, slot);
  if (!rect || !ppm || !placement) return null;
  return {
    x: rect.x + placement.xMm * ppm.x,
    y: rect.y + placement.yMm * ppm.y,
    w: placement.wMm * ppm.x,
    h: placementHeightMm(placement, artwork) * ppm.y,
  };
};

/** viewBox-px rect → CSS percentage box of the responsive garment wrapper. */
export const rectToPercent = (rect, viewBox) => ({
  left: `${(rect.x / viewBox.w) * 100}%`,
  top: `${(rect.y / viewBox.h) * 100}%`,
  width: `${(rect.w / viewBox.w) * 100}%`,
  height: `${(rect.h / viewBox.h) * 100}%`,
});

/** Is the placement horizontally centred in the print area? (0.05 mm tolerance —
 *  exact after a snap, and floating-point-safe.) */
export const isCenteredX = (placement, template, slot) => {
  const mm = template?.printAreaMm?.[slot];
  if (!mm || !placement) return false;
  return Math.abs(placement.xMm - (mm.w - placement.wMm) / 2) < 0.05;
};

/** Effective print DPI of the artwork at its CURRENT placement size (same math as
 *  the upload validator, but against the seller's chosen wMm×hMm instead of the
 *  full print area). Null when source dims are unknown. */
export const placementDpi = (placement, artwork) => {
  const a = artworkAspect(artwork);
  if (!a || !placement || !(placement.wMm > 0)) return null;
  return effectiveDpiFor(artwork.sourceWidthPx, artwork.sourceHeightPx, {
    w: placement.wMm,
    h: placement.wMm * a,
  });
};

/** Format mm as Swedish centimetres: one decimal, comma separator, trailing ,0
 *  stripped ("84" → "8,4 ", "300" → "30"). Number only — caller adds "cm". */
export const formatCm = (mmValue) => {
  const cm = Math.round(mmValue) / 10; // 1 mm (= 0.1 cm) precision
  const s = cm.toFixed(1).replace('.', ',');
  return s.endsWith(',0') ? s.slice(0, -2) : s;
};

/** "21 × 28 cm" for a placement (physical print size of the artwork). */
export const formatPlacementSizeCm = (placement, artwork) =>
  `${formatCm(placement.wMm)} × ${formatCm(placementHeightMm(placement, artwork))} cm`;

/**
 * The numeric cm readout — the feature no incumbent has. E.g.
 *   "4 cm uppifrån · centrerad · 21 × 28 cm"
 *   "4 cm uppifrån · 3,5 cm från vänster · 21 × 28 cm"
 * Distances are within the print area (the dashed zone), which is what the
 * printer measures against.
 */
export const placementReadout = (placement, template, slot, artwork) => {
  if (!placement) return '';
  const parts = [`${formatCm(placement.yMm)} cm uppifrån`];
  parts.push(isCenteredX(placement, template, slot) ? 'centrerad' : `${formatCm(placement.xMm)} cm från vänster`);
  parts.push(formatPlacementSizeCm(placement, artwork));
  // Rotation is part of the PRINT INSTRUCTION: this readout is what the printer
  // receives via the mapping — a rotated mockup without "roterad X°" would print
  // straight (the print file itself is the unrotated original).
  const deg = placement.rotationDeg || 0;
  if (Math.abs(deg) >= 0.25) {
    const s = (Math.round(deg * 10) / 10).toFixed(1).replace('.', ',');
    parts.push(`roterad ${s.endsWith(',0') ? s.slice(0, -2) : s}°`);
  }
  return parts.join(' · ');
};

/**
 * Human-Swedish DPI verdict for the CURRENT placement size, thresholds from the
 * print profile (settings/podProfiles — config-driven, no code change on retune).
 * Recomputed live on every resize; the message always names the physical cm size
 * so "too small a file" reads as a statement about THIS print, not abstract DPI.
 *   → { tier: 'PASS'|'WARN'|'FAIL', message }  |  null when DPI is unknowable.
 */
export const dpiVerdict = (placement, artwork, profile) => {
  const dpi = placementDpi(placement, artwork);
  if (dpi == null) return null;
  const min = profile?.min_dpi ?? 150;
  const target = profile?.target_dpi ?? 300;
  const size = formatPlacementSizeCm(placement, artwork);
  if (dpi < min) {
    return {
      tier: 'FAIL',
      message: `Blir suddigt tryckt i ${size} (${dpi} DPI, minst ${min} krävs). Förminska motivet eller ladda upp en större fil.`,
    };
  }
  if (dpi < target) {
    return {
      tier: 'WARN',
      message: `Något låg upplösning i ${size} — ${dpi} DPI (rekommenderat ${target}). Godkänt, men förminska motivet för skarpare tryck.`,
    };
  }
  return { tier: 'PASS', message: `Skarpt tryck i ${size} (${dpi} DPI).` };
};
