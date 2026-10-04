import { DISPATCH_HOLD_UNTIL_MS } from "../commerce/dispatch-hold";
import type { PrintLocation } from "./snapwear-wire";

/**
 * THE PRINT CANVAS (CP6-PS2, LAUNCH_TODO A5): what the printer receives for one
 * print slot of one order line when the canvas switch is on — a PNG of the
 * printer's WHOLE frame at print resolution with our motif placed in it,
 * instead of the bare motif (docs/cf-port/CP6_PS2_REPORT.md).
 *
 * Pure: geometry, keys, the switch and the one decision of which file a line
 * sends. The job queue is src/pod/print-canvas-jobs.ts, the pixels are made by
 * the render container (render/src/canvas.ts), and the dispatcher's seam is
 * printFilesForPrinter (dispatch-effect.ts).
 *
 * ── TO CONFIRM WITH SNAPWEAR (C1–C3) ────────────────────────────────────────
 * The owner decided (2026-10-04) to build this before SnapWear answered. Every
 * point that needs their answer is ONE constant or ONE function below, with the
 * assumption written beside it and a test in test/print-canvas.test.ts named
 * after the question. Where a wrong guess could print wrongly, the canvas fails
 * CLOSED: the line is not sent (a terminal dispatch with its alert) rather than
 * printed at a guess.
 *
 * Two facts that are NOT assumptions:
 *   - OUR placement is the studio's: the motif centred on both axes of the frame
 *     at its frozen width, no rotation (src/admin-app/adapters/studio.js
 *     serverPlacement; the seller cannot move it). No placement is stored, so
 *     the canvas derives it exactly as the studio drew the mockup.
 *   - The job body says nothing about placement (layouts[].location only,
 *     printer-client.ts toSnapwearJobBody): the printer applies ITS frame
 *     offset once, when it places the frame; our offset lives in the pixels.
 */

/**
 * The switch, read exactly as PS1 reads SNAPWEAR_SUBMIT_ENABLED: the string
 * "true" and nothing else. Off (absent, "false", "TRUE", " true") = the line
 * sends the artwork's stored print PNG, byte for byte as before PS2.
 */
export function printCanvasEnabled(env: Pick<Env, "PRINT_CANVAS_ENABLED">): boolean {
  return env.PRINT_CANVAS_ENABLED === "true";
}

/** C3 (DPI): ASSUMED 300 — the locked spec's floor (docs/POD_PRINT_SPEC.md §3). */
export const SNAPWEAR_CANVAS_DPI = 300;

/**
 * C3 (max file size): ASSUMED 100 MiB. A canvas over it is never sent: its job
 * fails at completion (`print_canvas_too_large`) and the dispatch fails with
 * its alert. The largest SnapWear frame (390×490 mm) at 300 DPI is 106.6 MB of
 * raw RGBA; a real full-frame photo compresses to 40–80 MB.
 */
export const SNAPWEAR_MAX_CANVAS_BYTES = 100 * 1024 * 1024;

/**
 * C3 (transparency): ASSUMED SnapWear prints a transparent PNG, ink only where
 * the motif is. If they do not, the canvas cannot be made honestly (a flat
 * background would ink the whole frame and needs the garment colour), so
 * canvasSpec refuses every line (`print_canvas_background_unsupported`).
 */
export const SNAPWEAR_CANVAS_TRANSPARENT: boolean = true;

/**
 * Ours, not SnapWear's: the largest canvas the container is asked to make. The
 * largest SnapWear frame is 26.7 Mpx at 300 DPI; this is 1.5× that. A frame
 * the capability schema admits (up to 2 000 mm) but this refuses would be a
 * data error, not a print.
 */
export const CANVAS_MAX_PIXELS = 40_000_000;

/**
 * Ours: the largest print master the container downloads for a canvas
 * (render/src/contract.ts CANVAS_MAX_INPUT_BYTES, pinned equal by the drift
 * test). A noisy 10 000 px master can exceed the artwork path's 200 MB.
 */
export const CANVAS_MAX_INPUT_BYTES = 512 * 1024 * 1024;

/** The geometry's own version, frozen into every job's spec. */
export const CANVAS_SPEC_VERSION = 1;

/** `last_error` of a dispatch row parked while its canvases render. */
export const PRINT_CANVAS_PENDING = "print_canvas_pending";

/**
 * `next_attempt_at` of a dispatch row parked while its canvases render. Year
 * 9999 like the other two holds, and a DIFFERENT instant from both on purpose:
 * releaseDispatchHolds wakes DISPATCH_HOLD_UNTIL_MS (payment), the sweeper's
 * releasePrinterHolds wakes DISPATCH_HOLD_UNTIL_MS − 1 s (no printer client).
 * Only a canvas job's settling (print-canvas-jobs.ts) and the sweeper's
 * backstop release this one.
 */
export const CANVAS_HOLD_UNTIL_MS = DISPATCH_HOLD_UNTIL_MS - 2_000;

const MM_PER_INCH = 25.4;

export interface FrameMm {
  h: number;
  offsetTopMm?: number;
  w: number;
}

/** One print slot of a line as the checkout froze it (CP2 + CP6-PS2 fields). */
export interface FrozenCanvasSlot {
  frameMm?: FrameMm;
  frameProvisional?: boolean;
  location: PrintLocation;
  r2Key: string;
  sha256: string;
  sourcePx?: { h: number; w: number };
  widthMm: number;
}

/** What the container renders, frozen on the job row (spec_json). */
export interface CanvasSpec {
  background: "transparent";
  canvasPx: { h: number; w: number };
  dpi: number;
  motifPx: { h: number; w: number };
  offsetPx: { left: number; top: number };
  sourcePx: { h: number; w: number };
  version: number;
}

export type CanvasSpecResult = { error: string; ok: false } | { ok: true; spec: CanvasSpec };

/** Floating-point slack of the millimetre fit (sizeSlot's own arithmetic), far under a pixel. */
const MM_FIT_TOLERANCE = 1e-6;

export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / MM_PER_INCH) * dpi);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * C1 (print frames): ASSUMED the frame the line froze — the article's MODEL
 * frame from SnapWear's PrintArea.xlsx (via the seed) — is the frame SnapWear
 * prints this SKU into. Per-SKU variants (PrintArea's `frameVariants`, ±3 mm)
 * are not modelled. FAIL CLOSED, never a guess:
 *   - no frozen frame (an order paid before CP6-PS2) → `print_canvas_frame_missing`;
 *   - a stand-in frame (the model's `provisional` flag: 64400, B445, SF500,
 *     TRUCKER, W101 have no frame in PrintArea.xlsx) → `print_canvas_frame_provisional`.
 */
export function canvasFrame(
  slot: Pick<FrozenCanvasSlot, "frameMm" | "frameProvisional">,
): { frame: FrameMm; ok: true } | { error: string; ok: false } {
  const frame = slot.frameMm;
  if (
    frame === undefined ||
    !isPositiveInt(frame.w) ||
    !isPositiveInt(frame.h) ||
    typeof slot.frameProvisional !== "boolean"
  ) {
    return { error: "print_canvas_frame_missing", ok: false };
  }
  if (slot.frameProvisional) {
    return { error: "print_canvas_frame_provisional", ok: false };
  }
  return { frame, ok: true };
}

/**
 * C2 ("offset from top": collar seam or pallet edge?): ASSUMED the canvas IS
 * the frame. SnapWear's offsetTopMm — from whichever reference — is applied by
 * SnapWear when it places the frame on the garment, so it is NOT drawn into
 * the canvas; the frame's top-left is the canvas's (0, 0). If SnapWear wants a
 * pallet-sized file instead, this returns the pallet as `canvasMm` and the
 * frame's position on it as `frameOriginMm` (pallet sizes would have to join
 * the printer's capabilities first: they are not there today).
 */
export function canvasReference(frame: FrameMm): {
  canvasMm: { h: number; w: number };
  frameOriginMm: { x: number; y: number };
} {
  return { canvasMm: { h: frame.h, w: frame.w }, frameOriginMm: { x: 0, y: 0 } };
}

/**
 * OURS (the studio's placement, not a SnapWear question): the motif centred on
 * both axes of the frame. Top-aligning it would change this function AND the
 * studio's serverPlacement in one release, or the print would no longer be the
 * mockup the buyer saw.
 */
export function motifPlacement(
  framePx: { h: number; w: number },
  motifPx: { h: number; w: number },
): { left: number; top: number } {
  return {
    left: Math.floor((framePx.w - motifPx.w) / 2),
    top: Math.floor((framePx.h - motifPx.h) / 2),
  };
}

/**
 * The whole geometry of one slot's canvas, computed once (at enqueue) and
 * frozen on the job. Refusals, each terminal for the line:
 *   print_canvas_background_unsupported  C3: transparency not accepted
 *   print_canvas_frame_missing           C1: no frozen frame
 *   print_canvas_frame_provisional       C1: a stand-in frame
 *   print_canvas_source_missing          no frozen artwork pixels
 *   print_canvas_too_large               more than CANVAS_MAX_PIXELS
 *   print_canvas_motif_exceeds_frame     the motif would not fit IN MILLIMETRES
 *                                        (never cropped or shrunk; impossible
 *                                        for a line that passed checkout, so it
 *                                        means bad data). A pixel of rounding
 *                                        past the frame is clamped, not refused
 */
export function canvasSpec(
  slot: FrozenCanvasSlot,
  assumptions: { dpi: number; transparent: boolean } = {
    dpi: SNAPWEAR_CANVAS_DPI,
    transparent: SNAPWEAR_CANVAS_TRANSPARENT,
  },
): CanvasSpecResult {
  const { dpi } = assumptions;
  if (!assumptions.transparent) {
    return { error: "print_canvas_background_unsupported", ok: false };
  }
  const framed = canvasFrame(slot);
  if (!framed.ok) {
    return framed;
  }
  const source = slot.sourcePx;
  if (source === undefined || !isPositiveInt(source.w) || !isPositiveInt(source.h)) {
    return { error: "print_canvas_source_missing", ok: false };
  }
  if (!isPositiveInt(slot.widthMm)) {
    return { error: "print_canvas_motif_exceeds_frame", ok: false };
  }

  const { frame } = framed;
  const reference = canvasReference(frame);
  const canvasPx = { h: mmToPx(reference.canvasMm.h, dpi), w: mmToPx(reference.canvasMm.w, dpi) };
  if (canvasPx.w < 1 || canvasPx.h < 1 || canvasPx.w * canvasPx.h > CANVAS_MAX_PIXELS) {
    return { error: "print_canvas_too_large", ok: false };
  }

  // Whether the motif fits is decided in MILLIMETRES, as checkout decided it
  // (pod-mappings.ts sizeSlot floors the width, so width × the artwork's
  // height/width is inside the frame). The pixels are then rounded twice — the
  // width, then the height from that width — which for a motif that fills the
  // frame's height can land a pixel or two past the frame's own rounded
  // height. Those pixels are clamped to the frame (under 0.1 % of the motif),
  // never a reason to refuse a line checkout accepted.
  const motifHeightMm = (slot.widthMm * source.h) / source.w;
  if (slot.widthMm > frame.w || motifHeightMm > frame.h + MM_FIT_TOLERANCE) {
    return { error: "print_canvas_motif_exceeds_frame", ok: false };
  }
  const framePx = { h: mmToPx(frame.h, dpi), w: mmToPx(frame.w, dpi) };
  const motifW = Math.min(mmToPx(slot.widthMm, dpi), framePx.w);
  const motifPx = { h: Math.min(Math.round((motifW * source.h) / source.w), framePx.h), w: motifW };
  if (motifPx.w < 1 || motifPx.h < 1) {
    return { error: "print_canvas_motif_exceeds_frame", ok: false };
  }

  const inFrame = motifPlacement(framePx, motifPx);
  const offsetPx = {
    left: mmToPx(reference.frameOriginMm.x, dpi) + inFrame.left,
    top: mmToPx(reference.frameOriginMm.y, dpi) + inFrame.top,
  };
  if (offsetPx.left + motifPx.w > canvasPx.w || offsetPx.top + motifPx.h > canvasPx.h) {
    return { error: "print_canvas_motif_exceeds_frame", ok: false };
  }

  return {
    ok: true,
    spec: {
      background: "transparent",
      canvasPx,
      dpi,
      motifPx,
      offsetPx,
      sourcePx: { h: source.h, w: source.w },
      version: CANVAS_SPEC_VERSION,
    },
  };
}

// ── keys (0053 pins both exactly) ───────────────────────────────────────────

/** The canonical canvas: under the order, in the shop's server-owned print path. */
export function canvasKey(tenantId: string, orderId: string, lineNo: number, slot: PrintLocation): string {
  return `pod/${tenantId}/print/orders/${orderId}/${lineNo}-${slot}.png`;
}

/** Where a job's attempts write before promotion (`attempt-{n}/canvas.png`). */
export function canvasOutputPrefix(
  tenantId: string,
  orderId: string,
  lineNo: number,
  slot: PrintLocation,
): string {
  return `pod/${tenantId}/render/canvas/${orderId}/${lineNo}/${slot}/`;
}

// ── which file a line sends ─────────────────────────────────────────────────

export type CanvasJobState = "completed" | "failed" | "leased" | "queued";

export interface CanvasJobView {
  canvasKey: string;
  canvasSha256: string | null;
  error: string | null;
  slot: PrintLocation;
  state: CanvasJobState;
}

export type PrintFilesDecision =
  | { kind: "artwork" }
  | { kind: "canvas"; files: Array<{ location: PrintLocation; r2Key: string; sha256: string }> }
  | { kind: "ensure" }
  | { error: string; kind: "terminal" };

/**
 * The one rule (docs/cf-port/CP6_PS2_REPORT.md §3):
 *   1. every slot has a completed canvas   → those canvases, whatever the switch
 *      (a re-dispatch after a lost answer gets the same file);
 *   2. the row was already submitted       → the artwork files: the job was
 *      first sent without a canvas, and the file sent for one job id never
 *      changes;
 *   3. switch off                          → the artwork files (pre-PS2);
 *   4. a canvas of the line failed         → terminal `print_canvas_failed`;
 *   5. otherwise                           → ensure the jobs and wait.
 */
export function decidePrintFiles(input: {
  canvases: readonly CanvasJobView[];
  slots: readonly PrintLocation[];
  submitted: boolean;
  switchOn: boolean;
}): PrintFilesDecision {
  const bySlot = new Map(input.canvases.map((canvas) => [canvas.slot, canvas]));
  const complete = input.slots.map((slot) => bySlot.get(slot));
  if (
    input.slots.length > 0 &&
    complete.every((canvas) => canvas?.state === "completed" && canvas.canvasSha256 !== null)
  ) {
    return {
      files: complete.map((canvas) => ({
        location: (canvas as CanvasJobView).slot,
        r2Key: (canvas as CanvasJobView).canvasKey,
        sha256: (canvas as CanvasJobView).canvasSha256 as string,
      })),
      kind: "canvas",
    };
  }
  if (input.submitted || !input.switchOn) {
    return { kind: "artwork" };
  }
  if (input.slots.some((slot) => bySlot.get(slot)?.state === "failed")) {
    return { error: "print_canvas_failed", kind: "terminal" };
  }
  return { kind: "ensure" };
}
