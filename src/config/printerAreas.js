// printerAreas.js — derive the Design Studio template for the ROUTED printer's
// real print frames (SnapWear A3). PURE: no firebase, no React, no I/O — it lives
// outside podMockupTemplates.js (which imports firebase/config) so plain
// `node --test` / rules-tests can import it; podMockupTemplates re-exports it.
//
// WHY: a mockup template carries OUR generic print areas (POD_PRINT_SPEC §1,
// front 300×350 mm …), but what can actually be printed is the PRINTER's frame
// — SnapWear's tee front is 390×490 mm, its hoodie front only 390×280 (the
// kangaroo pocket), and it prints no sleeves at all. printers/{uid}.printAreasMm
// [garment][slot] = { w, h, offsetTopMm? } holds those frames; this turns
// (template, frames) into the template every studio consumer reads.
//
// ⚠️ THE DPI GATE IS UNCHANGED BY LARGER FRAMES. The library upload gate
// (functions/src/pod/processArtwork.ts) still requires ≥300 DPI at contain-fit
// in the podProfiles reference area, and the studio's HARD clamp —
// placementMath maxWidthForDpiMm, applied in clampPlacement / defaultPlacement /
// containPlacement — is per ARTWORK (source px ÷ min DPI), independent of the
// area. A 390 mm frame lets a big file print bigger; it never lets a small file
// scale into blur.
//
// The 3D view (pod3dModels.printAreaMm / Studio3DSection) is NOT derived here:
// it is a read-only preview ("3D is never a print instruction") — follow-up.
import { isSlotPrintableInAreas } from '../wagons/pod-wagon/printRouting.js';

const round2 = (n) => Math.round(n * 100) / 100;
const isArea = (a) =>
  !!a && typeof a === 'object' && Number.isFinite(a.w) && a.w > 0 && Number.isFinite(a.h) && a.h > 0;

/**
 * applyPrinterAreas(template, areasForGarment) → template (NEW object)
 *
 * `areasForGarment` = printers/{routedUid}.printAreasMm[garmentOfTemplate(t)].
 * null/undefined (no printer routed, or it recorded no frames for this garment)
 * → the template is returned UNCHANGED (pre-seed behaviour, same reference).
 *
 * Otherwise, per slot of template.printAreas:
 *   • printer cannot print it (isSlotPrintableInAreas: absent slot; pocket
 *     survives via front) → DROPPED from printAreas, printAreaMm, slotLabels
 *     (and pocketPositions when it is the pocket). Sleeve rows then vanish from
 *     the studio automatically — templateSlots reads printAreas.
 *   • printer has its own frame → printAreaMm[slot] = { w, h } from the
 *     printer, and the px rect is RESCALED at the template's OWN px/mm
 *     (rect.w / oldMm.w, rect.h / oldMm.h), anchored at its TOP-CENTRE (x
 *     centre and top y kept), so the preview stays calibrated to the photo.
 *     When BOTH the printer's offsetTopMm and the template's
 *     printOffsetTopMm[slot] are known, the rect then shifts vertically by
 *     (printer − template) × px/mm.y so the frame sits where the printer
 *     starts printing below the collar.
 *   • pocket via front (no own frame) → kept exactly as the template has it
 *     (the fixed 100×100 left-chest spot); pocketPositions keep their x.
 *     When the printer DOES give a pocket frame of another width, every
 *     pocketPositions x shifts by half the width change so each discrete
 *     position stays centred where it was.
 *
 * Never mutates the input — the template array is a module-level cache shared
 * by every studio mount.
 */
export const applyPrinterAreas = (template, areasForGarment) => {
  if (!template || !areasForGarment || typeof areasForGarment !== 'object') return template;
  const srcRects = template.printAreas || {};
  const srcMm = template.printAreaMm || {};
  const printAreas = {};
  const printAreaMm = {};
  const kept = [];
  let pocketDx = 0;

  for (const slot of Object.keys(srcRects)) {
    if (!isSlotPrintableInAreas(areasForGarment, slot)) continue;
    kept.push(slot);
    const rect = srcRects[slot];
    const oldMm = srcMm[slot];
    const area = areasForGarment[slot];
    // Pocket riding on front, or a template slot we cannot rescale (no mm to
    // derive px/mm from): keep the template's own geometry verbatim.
    if (!isArea(area) || !rect || !isArea(oldMm)) {
      printAreas[slot] = rect ? { ...rect } : rect;
      if (oldMm) printAreaMm[slot] = { ...oldMm };
      continue;
    }
    const ppmX = rect.w / oldMm.w;
    const ppmY = rect.h / oldMm.h;
    const w = area.w * ppmX;
    const h = area.h * ppmY;
    let y = rect.y;
    const tmplOffset = template.printOffsetTopMm?.[slot];
    if (Number.isFinite(area.offsetTopMm) && Number.isFinite(tmplOffset)) {
      y += (area.offsetTopMm - tmplOffset) * ppmY;
    }
    printAreas[slot] = { ...rect, x: round2(rect.x + rect.w / 2 - w / 2), y: round2(y), w: round2(w), h: round2(h) };
    printAreaMm[slot] = { w: area.w, h: area.h };
    if (slot === 'pocket') pocketDx = (rect.w - w) / 2;
  }

  const next = { ...template, printAreas, printAreaMm };
  if (template.slotLabels) {
    next.slotLabels = Object.fromEntries(Object.entries(template.slotLabels).filter(([s]) => kept.includes(s)));
  }
  if (template.pocketPositions) {
    if (!kept.includes('pocket')) {
      delete next.pocketPositions;
    } else {
      next.pocketPositions = Object.fromEntries(Object.entries(template.pocketPositions).map(
        ([pos, p]) => [pos, { ...p, ...(Number.isFinite(p?.x) ? { x: round2(p.x + pocketDx) } : {}) }]
      ));
    }
  }
  return next;
};
