/** Synthetic images, made with sharp in memory — no fixture files in the repo. */
import { randomUUID } from "node:crypto";

import sharp from "sharp";

import type { JobProfile } from "../src/contract.ts";

/** The real garment-front profile shape (docs/POD_PRINT_SPEC.md: 250 × 350 mm, ≥ 300 DPI). */
export const PROFILE: JobProfile = {
  accepted_formats: [{ ext: "png" }, { ext: "jpg" }, { ext: "tiff" }, { ext: "webp" }],
  id: "front_a3",
  max_file_mb: 150,
  min_dpi: 300,
  print_area_mm: { h: 350, w: 250 },
};

/**
 * A transparent PNG with an opaque (or `motifAlpha`) red motif filling a centred
 * fraction of the canvas. `motifFraction: 1` fills it edge to edge, so the trim is a
 * no-op and the gate measures exactly w × h.
 */
export async function transparentPng(
  w: number,
  h: number,
  motifFraction = 1,
  motifAlpha = 255,
): Promise<Buffer> {
  const mw = Math.max(1, Math.round(w * motifFraction));
  const mh = Math.max(1, Math.round(h * motifFraction));
  const motif = await sharp({
    create: { background: { alpha: motifAlpha / 255, b: 40, g: 30, r: 220 }, channels: 4, height: mh, width: mw },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { background: { alpha: 0, b: 0, g: 0, r: 0 }, channels: 4, height: h, width: w },
  })
    .composite([{ input: motif, left: Math.floor((w - mw) / 2), top: Math.floor((h - mh) / 2) }])
    .png()
    .toBuffer();
}

export async function opaqueJpeg(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { background: { b: 60, g: 180, r: 200 }, channels: 3, height: h, width: w } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export function leaseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const prefix = "pod/tenant-a/render/artwork-a/1/attempt-1/";
  const base = "https://testaccount.eu.r2.cloudflarestorage.com/chopshop-test-private";
  return {
    attempt: 1,
    contract: 1,
    input: {
      maxBytes: 4_000_000,
      url: `${base}/shops/tenant-a/artwork_original/o/v1/motif.png?X-Amz-Expires=300&X-Amz-Signature=sig`,
    },
    jobId: randomUUID(),
    jobType: "pod.process_artwork",
    leaseToken: "L".repeat(43),
    leaseUntil: new Date(Date.now() + 600_000).toISOString(),
    output: {
      previewWebpPutUrl: `${base}/${prefix}preview.webp?X-Amz-Expires=900&X-Amz-Signature=sig`,
      printPngPutUrl: `${base}/${prefix}print.png?X-Amz-Expires=900&X-Amz-Signature=sig`,
    },
    outputPrefix: prefix,
    profile: PROFILE,
    ...overrides,
  };
}
