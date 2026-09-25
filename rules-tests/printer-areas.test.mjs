/**
 * SnapWear A3 — per-printer print areas in the Design Studio (pure unit tests).
 *
 * applyPrinterAreas (src/config/printerAreas.js) turns a mockup template + the
 * ROUTED printer's frames (printers/{uid}.printAreasMm[garment]) into the
 * template every studio consumer reads; placementFits (placementMath.js) is the
 * publish-time "does this stored placement still fit that area?" check.
 * Fixtures mirror the real seed data (scripts/seed-pod-mockup-templates.cjs +
 * scripts/seed-snapwear-printer.cjs).
 *
 * RUN: node rules-tests/printer-areas.test.mjs
 */
import { applyPrinterAreas } from '../src/config/printerAreas.js';
import { placementFits, clampPlacement, pxPerMm, maxWidthForDpiMm } from '../src/wagons/pod-wagon/studio/placementMath.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅', m); } else { fail++; console.log('  ❌', m); } };
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const clone = (o) => JSON.parse(JSON.stringify(o));

// tee_bc_e150 (photo template) — values from the seed script.
const TEE = {
  id: 'tee_bc_e150',
  garment: 'tee',
  printAreas: {
    front: { x: 342, y: 411, w: 276, h: 322 },
    back: { x: 340, y: 340, w: 280, h: 373 },
    pocket: { x: 535, y: 365, w: 92, h: 92 },
    left_sleeve: { x: 725, y: 365, w: 74, h: 74 },
    right_sleeve: { x: 160, y: 365, w: 74, h: 74 },
  },
  pocketPositions: { left: { x: 535 }, center: { x: 434 }, right: { x: 333 } },
  printAreaMm: {
    front: { w: 300, h: 350 },
    back: { w: 300, h: 400 },
    pocket: { w: 100, h: 100 },
    left_sleeve: { w: 80, h: 80 },
    right_sleeve: { w: 80, h: 80 },
  },
  slotLabels: { front: 'Bröst', left_sleeve: 'Vänster ärm' },
};
// hoodie_hanging
const HOODIE = {
  id: 'hoodie_hanging',
  garment: 'hoodie',
  printAreas: {
    front: { x: 337, y: 387, w: 294, h: 313 },
    back: { x: 366, y: 350, w: 228, h: 304 },
    pocket: { x: 542, y: 387, w: 98, h: 98 },
    left_sleeve: { x: 735, y: 410, w: 78, h: 78 },
    right_sleeve: { x: 155, y: 410, w: 78, h: 78 },
  },
  printAreaMm: {
    front: { w: 300, h: 320 },
    back: { w: 300, h: 400 },
    pocket: { w: 100, h: 100 },
    left_sleeve: { w: 80, h: 80 },
    right_sleeve: { w: 80, h: 80 },
  },
};
// SnapWear frames (seed-snapwear-printer.cjs dry run).
const SNAP_TEE = {
  front: { w: 390, h: 490, offsetTopMm: 30 },
  back: { w: 390, h: 490, offsetTopMm: 40 },
  pocket: { w: 100, h: 100 },
};
const SNAP_HOODIE = {
  front: { w: 390, h: 280, offsetTopMm: 30 },
  back: { w: 390, h: 490, offsetTopMm: 60 },
};

console.log('\n=== null/absent frames → identity (pre-seed behaviour) ===');
ok(applyPrinterAreas(TEE, null) === TEE, 'null areas → the SAME template object');
ok(applyPrinterAreas(TEE, undefined) === TEE, 'undefined areas → the same template object');
ok(applyPrinterAreas(null, SNAP_TEE) === null, 'null template → null (no throw)');

console.log('\n=== slots the printer cannot print are DROPPED ===');
const tee = applyPrinterAreas(TEE, SNAP_TEE);
ok(!('left_sleeve' in tee.printAreas) && !('right_sleeve' in tee.printAreas), 'both sleeves gone from printAreas');
ok(!('left_sleeve' in tee.printAreaMm) && !('right_sleeve' in tee.printAreaMm), '… and from printAreaMm');
ok(!('left_sleeve' in tee.slotLabels) && tee.slotLabels.front === 'Bröst', '… and from slotLabels (others kept)');
ok(Object.keys(tee.printAreas).sort().join() === 'back,front,pocket', 'front, back and pocket survive');

console.log('\n=== tee front GROWS to SnapWear 390×490 at the template\'s own px/mm ===');
{
  const oldPpm = pxPerMm(TEE, 'front');
  const newPpm = pxPerMm(tee, 'front');
  ok(tee.printAreaMm.front.w === 390 && tee.printAreaMm.front.h === 490, 'printAreaMm.front = 390×490');
  ok(near(newPpm.x, oldPpm.x, 0.001) && near(newPpm.y, oldPpm.y, 0.001),
    `px/mm unchanged (${oldPpm.x.toFixed(3)} / ${oldPpm.y.toFixed(3)})`);
  ok(near(tee.printAreas.front.h, 322 * 490 / 350), `px height 322 → ${tee.printAreas.front.h} (× 490/350)`);
  const oldCx = TEE.printAreas.front.x + TEE.printAreas.front.w / 2;
  const newCx = tee.printAreas.front.x + tee.printAreas.front.w / 2;
  ok(near(oldCx, newCx), `x-centre kept (${oldCx} → ${newCx.toFixed(2)})`);
  ok(tee.printAreas.front.y === TEE.printAreas.front.y, 'top y kept (template has no printOffsetTopMm)');
}

console.log('\n=== hoodie front SHRINKS 320 → 280 mm (kangaroo pocket), px height × 280/320 ===');
const hoodie = applyPrinterAreas(HOODIE, SNAP_HOODIE);
ok(hoodie.printAreaMm.front.h === 280 && hoodie.printAreaMm.front.w === 390, 'printAreaMm.front = 390×280');
ok(near(hoodie.printAreas.front.h, 313 * 280 / 320), `px height 313 → ${hoodie.printAreas.front.h}`);
ok(hoodie.printAreas.front.y === HOODIE.printAreas.front.y, 'top edge stays put — it shrinks from the bottom');

console.log('\n=== pocket survives via FRONT when the printer gives no pocket frame ===');
ok(!!hoodie.printAreas.pocket, 'hoodie keeps its pocket slot (no own frame, front exists)');
ok(JSON.stringify(hoodie.printAreas.pocket) === JSON.stringify(HOODIE.printAreas.pocket)
  && hoodie.printAreaMm.pocket.w === 100, 'pocket geometry is the template\'s own, untouched (100×100)');
ok(!('left_sleeve' in hoodie.printAreas), 'hoodie sleeves dropped too');
{
  const frontOnlyAccessory = applyPrinterAreas(
    { printAreas: { front: { x: 330, y: 330, w: 140, h: 100 } }, printAreaMm: { front: { w: 70, h: 50 } } },
    { front: { w: 70, h: 50 } }
  );
  ok(frontOnlyAccessory.printAreaMm.front.w === 70 && frontOnlyAccessory.printAreas.front.w === 140,
    'a cap whose frame equals the template keeps an identical rect');
}
{
  const noFront = applyPrinterAreas(TEE, { back: { w: 390, h: 490 } });
  ok(!noFront.printAreas.pocket && !noFront.pocketPositions, 'no front and no pocket frame → pocket (and its positions) dropped');
}
{
  const widerPocket = applyPrinterAreas(TEE, { front: SNAP_TEE.front, pocket: { w: 120, h: 120 } });
  const dx = (92 - 120 * 0.92) / 2;
  ok(near(widerPocket.pocketPositions.left.x, 535 + dx) && near(widerPocket.pocketPositions.right.x, 333 + dx),
    'a wider printer pocket shifts every discrete position by half the growth (positions stay centred)');
}

console.log('\n=== offsetTopMm shifts the rect when BOTH offsets are known ===');
{
  const withOffsets = { ...TEE, printOffsetTopMm: { front: 65, back: 85 } };
  const t = applyPrinterAreas(withOffsets, SNAP_TEE);
  const ppmY = 322 / 350;
  ok(near(t.printAreas.front.y, 411 + (30 - 65) * ppmY), `front moves up 35 mm → y ${t.printAreas.front.y}`);
  ok(near(t.printAreas.back.y, 340 + (40 - 85) * (373 / 400)), `back moves up 45 mm → y ${t.printAreas.back.y}`);
}

console.log('\n=== the cached template is NEVER mutated ===');
{
  const before = clone(TEE);
  const beforeH = clone(HOODIE);
  applyPrinterAreas(TEE, SNAP_TEE);
  applyPrinterAreas(TEE, { back: { w: 1, h: 1 } });
  applyPrinterAreas(HOODIE, SNAP_HOODIE);
  ok(JSON.stringify(TEE) === JSON.stringify(before), 'tee template deep-equal before/after');
  ok(JSON.stringify(HOODIE) === JSON.stringify(beforeH), 'hoodie template deep-equal before/after');
  ok(tee.printAreas !== TEE.printAreas && tee.printAreaMm !== TEE.printAreaMm, 'derived maps are fresh objects');
}

console.log('\n=== placementFits: the publish-time no-op-clamp check ===');
{
  const art = { sourceWidthPx: 4000, sourceHeightPx: 4000 }; // square, big
  const inTee = { xMm: 20, yMm: 30, wMm: 250, rotationDeg: 0 };
  ok(placementFits(inTee, tee, 'front', art, 300) === true, 'a placement inside the 390×490 front fits');
  const tooLowForHoodie = { xMm: 20, yMm: 30, wMm: 300, rotationDeg: 0 }; // 300 high > 280
  ok(placementFits(tooLowForHoodie, hoodie, 'front', art, 300) === false,
    'the same 300 mm square does NOT fit the 280-high hoodie front');
  const clamped = clampPlacement(tooLowForHoodie, hoodie, 'front', art, 300);
  ok(placementFits(clamped, hoodie, 'front', art, 300) === true, 'its clamped version fits (clamp is idempotent)');
  ok(placementFits(inTee, tee, 'left_sleeve', art, 300) === false, 'a dropped slot never fits');
  ok(placementFits(null, tee, 'front', art, 300) === true, 'no stored placement → default placement → fits');
  ok(placementFits(inTee, tee, 'front', { sourceWidthPx: null }, 300) === true, 'unknown dims → nothing to clamp → fits');
  const rotatedTooFar = { ...inTee, rotationDeg: 45 };
  ok(placementFits(rotatedTooFar, tee, 'front', art, 300) === false, 'rotation beyond the 30° cap does not fit');
}

console.log('\n=== DPI clamp is per ARTWORK — a bigger frame never allows blur ===');
{
  const small = { sourceWidthPx: 1200, sourceHeightPx: 1200 }; // ≤ 101.6 mm at 300 DPI
  const cap = maxWidthForDpiMm(small, 300);
  ok(near(cap, 101.6, 0.01), `1200 px at 300 DPI → max ${cap.toFixed(1)} mm wide`);
  const wide = { xMm: 0, yMm: 0, wMm: 380, rotationDeg: 0 };
  const c = clampPlacement(wide, tee, 'front', small, 300);
  ok(near(c.wMm, 101.6, 0.01), `in SnapWear's 390 mm frame it still clamps to ${c.wMm.toFixed(1)} mm`);
  ok(placementFits(wide, tee, 'front', small, 300) === false, 'so a 380 mm stored width does not "fit"');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} printer-areas: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
