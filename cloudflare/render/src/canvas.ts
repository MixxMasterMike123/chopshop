/**
 * The print canvas (CP6-PS2, LAUNCH_TODO A5): the printer's whole frame at print
 * resolution with the motif placed in it, made from the artwork's print master.
 *
 * The geometry is NOT decided here: the Worker computed it once from the line's
 * frozen facts and froze it on the job (src/dispatch/print-canvas.ts canvasSpec,
 * where every SnapWear assumption lives). This file only executes it:
 *
 *   verify the input is the frozen master (sha256) and has the frozen pixels
 *   → resize to the motif box (lanczos3, exact box) → extend to the canvas with
 *   a fully transparent background at the offset → 8-bit sRGB RGBA PNG whose
 *   pHYs says the DPI → verify the output's size.
 *
 * A mismatch is a REFUSAL (`ok: false`, a code): retrying cannot fix it, and the
 * API ends the job at once. Anything else that goes wrong throws (the job's
 * attempt fails and is retried). The same sharp version renders the same bytes
 * for the same input and spec; the API keeps the first canvas a line gets in any
 * case (create-if-absent promotion).
 *
 * Process settings (cache off, concurrency 1) are pipeline.ts's, set at its
 * module load; this file imports it for that reason.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import sharp from "sharp";

import type { CanvasSpec, Notice } from "./contract.ts";
import { DECODE_PIXEL_LIMIT } from "./pipeline.ts";

export type CanvasResult = { ok: true } | { ok: false; reasons: Notice[] };

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function refuse(code: string, message: string): CanvasResult {
  return { ok: false, reasons: [{ code, message }] };
}

export async function renderCanvas(
  input: { path: string; sha256: string },
  spec: CanvasSpec,
  outPath: string,
): Promise<CanvasResult> {
  if ((await sha256File(input.path)) !== input.sha256) {
    return refuse("input_mismatch", "The downloaded file is not the print master the line froze.");
  }

  const meta = await sharp(input.path, { limitInputPixels: DECODE_PIXEL_LIMIT }).metadata();
  if (meta.width !== spec.sourcePx.w || meta.height !== spec.sourcePx.h) {
    return refuse("dims_mismatch", "The print master's pixel size is not the one the line froze.");
  }

  const left = spec.offsetPx.left;
  const top = spec.offsetPx.top;
  const right = spec.canvasPx.w - left - spec.motifPx.w;
  const bottom = spec.canvasPx.h - top - spec.motifPx.h;
  if (left < 0 || top < 0 || right < 0 || bottom < 0) {
    return refuse("motif_exceeds_canvas", "The motif would not fit inside the canvas.");
  }

  await sharp(input.path, { limitInputPixels: DECODE_PIXEL_LIMIT })
    .ensureAlpha()
    .resize(spec.motifPx.w, spec.motifPx.h, { fit: "fill", kernel: "lanczos3" })
    .extend({ background: { alpha: 0, b: 0, g: 0, r: 0 }, bottom, left, right, top })
    .toColourspace("srgb")
    .withMetadata({ density: spec.dpi })
    .png()
    .toFile(outPath);

  const out = await sharp(outPath).metadata();
  if (out.width !== spec.canvasPx.w || out.height !== spec.canvasPx.h || out.channels !== 4) {
    throw new Error("canvas_output_mismatch");
  }
  return { ok: true };
}
