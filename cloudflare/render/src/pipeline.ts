/**
 * The POD artwork pipeline — the 300-DPI gate the print shop contract
 * (docs/POD_PRINT_SPEC.md, locked 2026-07-27) is written against.
 *
 *   decode (by CONTENT, not extension) → EXIF-rotate → auto-trim transparent
 *   margins → ICC/CMYK → sRGB (8-bit) → GATE (contain-fit ≥ min_dpi) → print PNG
 *   + 800 px preview WebP → verdict + notices.
 *
 * PORTED from the old farm's pure pipeline core, not copied: every check, its
 * ORDER, every threshold, every Swedish user-facing message and every notice /
 * reason code is the same, on the same sharp minor (0.35; pinned exactly to 0.35.4 in
 * package.json — the farm ran 0.35.3, whose bundled libheif carries two published
 * advisories, and this process parses untrusted uploads) with the same process
 * settings (cache off, concurrency 1). Keep
 * the gate math in sync with the client mirror (src/utils/podValidation.js):
 * contain semantics, ROUND at the boundary.
 *
 * ONE DELIBERATE DIFFERENCE, I/O only: the input is read from a FILE the job
 * streamed to disk, and both outputs are WRITTEN to files, instead of every stage
 * living in a Buffer. libvips encodes identically either way (test/pipeline.test.ts
 * pins the bytes against the buffer path), but the compressed input and the
 * encoded print PNG — up to hundreds of MB for a 10 000 px motif — never sit in
 * the JS heap, so the peak is the decode alone. That was the 2026-07-27 OOM.
 *
 * Nothing here knows about tenants, jobs, URLs or storage keys.
 */
import { open } from "node:fs/promises";

import sharp, { type Metadata } from "sharp";

import type { JobProfile, Notice, PipelineMeta } from "./contract.ts";

export const PIPELINE_VERSION = 1;

// libvips' operation cache holds decoded pixels across jobs — with ~200 MB raw per
// 7000 px image that OOMed the old farm (live, 2026-07-27, 1 GiB). No cache hits
// are possible here (every job is a new image), so trade them for a flat memory
// profile. Process-global and set at module load, before any sharp work.
sharp.cache(false);
sharp.concurrency(1);

const MM_PER_INCH = 25.4;
// Hard ceiling on source pixels (spec §8) — protects this process's memory.
const MAX_SOURCE_PX = 10_000;
const DECODE_PIXEL_LIMIT = (MAX_SOURCE_PX + 2_000) * (MAX_SOURCE_PX + 2_000);
const PREVIEW_MAX_EDGE = 800;
// Alpha thresholds: <250 counts as "not fully opaque" (parity with the legacy
// client probe); trim threshold ~5% alpha; semi band = 5%..95%.
const OPAQUE_RATIO = 0.005;
const TRIM_THRESHOLD = 13; // 0..255 ≈ 5% alpha
const SEMI_LO = 13;
const SEMI_HI = 242;
const SEMI_NOTICE_RATIO = 0.05;

export type PipelineResult =
  | { ok: false; reasons: Notice[] }
  | { meta: PipelineMeta; notices: Notice[]; ok: true };

// ── gate math (MIRRORS src/utils/podValidation.js — keep in sync) ───────────
type Area = { h: number; w: number };

function maxPrintMmFor(widthPx: number, heightPx: number, area: Area): Area {
  const aspect = widthPx / heightPx;
  const w = Math.min(area.w, area.h * aspect);
  return { h: w / aspect, w };
}

function containDpiFor(widthPx: number, heightPx: number, area: Area): number {
  const { w } = maxPrintMmFor(widthPx, heightPx, area);
  return Math.round(widthPx / (w / MM_PER_INCH));
}

function requiredPxFor(widthPx: number, heightPx: number, area: Area, dpi: number): Area {
  const { h, w } = maxPrintMmFor(widthPx, heightPx, area);
  return { h: Math.round((h / MM_PER_INCH) * dpi), w: Math.round((w / MM_PER_INCH) * dpi) };
}

function formatMmAsCm(mm: number): string {
  const r = Math.round(mm) / 10;
  const s = Math.round(r * 10) / 10;
  return Number.isInteger(s) ? String(s) : String(s).replace(".", ",");
}

// Dedicated rejections for formats users realistically try (spec §8).
const SPECIAL_FORMAT_FAIL: Record<string, string> = {
  gif: "GIF är ett webbformat, inte ett tryckformat. Exportera motivet som PNG.",
  heif: 'iPhone-bild (HEIC) stöds inte. Välj "Mest kompatibel" under Inställningar → Kamera → Format, eller exportera bilden som JPG/PNG och ladda upp igen.',
  pdf: "PDF stöds inte för tryck på textil. Exportera motivet som PNG i full storlek från ditt designprogram.",
  svg: "SVG stöds inte ännu. Exportera motivet som PNG i full storlek (behåll transparent bakgrund).",
};

// sharp metadata().format → the profile format vocabulary.
const FORMAT_TO_EXT: Record<string, string> = {
  jpeg: "jpg",
  png: "png",
  tiff: "tiff",
  webp: "webp",
};

// HEIC often fails to DECODE (no codec) rather than identify — sniff the magic
// bytes so iPhone users get the dedicated message, not "korrupt fil".
function looksLikeHeic(head: Buffer): boolean {
  return (
    head.length > 12 &&
    head.subarray(4, 8).toString("ascii") === "ftyp" &&
    /^(heic|heix|heif|hevc|mif1|msf1)/.test(head.subarray(8, 12).toString("ascii"))
  );
}

async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function reject(code: string, message: string): PipelineResult {
  return { ok: false, reasons: [{ code, message }] };
}

/**
 * Run the pipeline on the file at `input.path` (`input.bytes` long). On `ok: true`
 * the print PNG is at `out.printPath` and the preview WebP at `out.previewPath`; on
 * a rejection either may or may not exist and the caller discards both.
 */
export async function runArtworkPipeline(
  input: { bytes: number; path: string },
  profile: JobProfile,
  out: { previewPath: string; printPath: string },
): Promise<PipelineResult> {
  const notices: Notice[] = [];

  // ── size gate ──
  const maxBytes = (profile.max_file_mb || 0) * 1024 * 1024;
  if (maxBytes && input.bytes > maxBytes) {
    return reject(
      "file_too_large",
      `Filen är ${(input.bytes / 1024 / 1024).toFixed(1)} MB — max ${profile.max_file_mb} MB.`,
    );
  }

  // ── identify by CONTENT (wrong extensions are normalized away here) ──
  // metadata() only reads headers, so NO pixel limit here — an oversized image
  // must reach the px_too_large branch below (actionable "Skala ner" message),
  // not die in this try as "korrupt fil". Decode ops keep the limit as backstop.
  let meta: Metadata;
  try {
    meta = await sharp(input.path, { limitInputPixels: false }).metadata();
  } catch {
    if (looksLikeHeic(await readHead(input.path))) {
      return reject("format_heic", SPECIAL_FORMAT_FAIL.heif as string);
    }
    return reject(
      "unreadable",
      "Filen kunde inte läsas — den kan vara skadad. Ladda ner originalet igen och försök på nytt.",
    );
  }

  const fmt = meta.format || "";
  const special = SPECIAL_FORMAT_FAIL[fmt];
  if (special !== undefined) {
    return reject(`format_${fmt}`, special);
  }
  const ext = FORMAT_TO_EXT[fmt];
  const accepted = (profile.accepted_formats || []).map((f) => String(f.ext).toLowerCase());
  if (!ext || !accepted.includes(ext)) {
    const allowed = accepted.map((a) => a.toUpperCase()).join(", ");
    return reject(
      "format_not_accepted",
      `Formatet ${fmt ? "." + fmt : ""} stöds inte. Tillåtna format: ${allowed}.`,
    );
  }

  if (!meta.width || !meta.height) {
    return reject("unreadable", "Kunde inte läsa bildens mått — filen kan vara skadad.");
  }
  // EXIF orientation 5-8 swaps the axes; measure in DISPLAY orientation.
  const swapped = (meta.orientation || 1) >= 5;
  const srcW = swapped ? meta.height : meta.width;
  const srcH = swapped ? meta.width : meta.height;
  if (Math.max(srcW, srcH) > MAX_SOURCE_PX) {
    return reject(
      "px_too_large",
      `Bilden är ${srcW} × ${srcH} px — max ${MAX_SOURCE_PX} px på längsta sidan. Skala ner filen.`,
    );
  }

  // ── normalize: rotate → trim transparent margins → sRGB 8-bit PNG ──
  // toColourspace('srgb') converts CMYK/wide-gamut (via embedded ICC when present)
  // to 8-bit sRGB — spec §8 "Färg". Alpha survives the PNG re-encode untouched.
  const work = sharp(input.path, { limitInputPixels: DECODE_PIXEL_LIMIT }).rotate();

  if (meta.space === "cmyk") {
    notices.push({
      code: "cmyk_converted",
      message:
        "Filen var i CMYK och har konverterats till RGB — färgerna kan skifta något. Kontrollera mockupen.",
    });
  }

  // ONE decode+encode pass produces the final PNG (rotate → [trim] → sRGB).
  let trimApplied = false;
  if (meta.hasAlpha) {
    // Auto-trim transparent padding so the GATE measures the MOTIF, not the
    // artboard (spec §8 — without this the gate and the cm readouts lie). Trim keys
    // on the fully transparent background; the threshold tolerates stray near-zero
    // alpha.
    try {
      await work
        .trim({ background: { alpha: 0, b: 0, g: 0, r: 0 }, threshold: TRIM_THRESHOLD })
        .toColourspace("srgb")
        .png()
        .toFile(out.printPath);
      trimApplied = true;
    } catch {
      // Trim failure: proceed untrimmed (never block on the optimizer). A fully
      // transparent image passes trim UNCHANGED — that case is caught below via
      // the alpha statistics, not here.
      await sharp(input.path, { limitInputPixels: DECODE_PIXEL_LIMIT })
        .rotate()
        .toColourspace("srgb")
        .png()
        .toFile(out.printPath);
    }
  } else {
    await work.toColourspace("srgb").png().toFile(out.printPath);
  }

  const outMeta = await sharp(out.printPath).metadata();
  const width = outMeta.width || 0;
  const height = outMeta.height || 0;
  if (!width || !height) {
    return reject("unreadable", "Bearbetningen gav en tom bild — filen kan vara skadad.");
  }
  if (trimApplied && (width !== srcW || height !== srcH)) {
    notices.push({
      code: "trimmed",
      message: `Genomskinliga marginaler beskars automatiskt (${srcW} × ${srcH} → ${width} × ${height} px) så att måtten gäller själva motivet.`,
    });
  }

  // ── THE GATE: contain-fit ≥ min_dpi on the processed (trimmed) motif ──
  const area = profile.print_area_mm;
  const maxPrintMm = maxPrintMmFor(width, height, area);
  const effectiveDpi = containDpiFor(width, height, area);
  const requiredPx = requiredPxFor(width, height, area, profile.min_dpi);
  if (effectiveDpi < profile.min_dpi) {
    return reject(
      "resolution_too_low",
      `Motivet är ${width} × ${height} px. I sin största tryckstorlek ` +
        `${formatMmAsCm(maxPrintMm.w)} × ${formatMmAsCm(maxPrintMm.h)} cm blir det ${effectiveDpi} DPI — ` +
        `minimikravet är ${profile.min_dpi} DPI. För din bilds proportioner krävs minst ${requiredPx.w} × ${requiredPx.h} px. ` +
        `Exportera om från originalet i full storlek — uppskalning i efterhand hjälper inte.`,
    );
  }

  // ── transparency: fully-empty reject + notices (spec §4, §8) ──
  // Transparency is INFORM-ONLY: an opaque motif is print-legal.
  const alpha = await alphaProfile(out.printPath);
  if (alpha.visibleRatio === 0 && alpha.hasAlphaChannel) {
    // Nothing above the visibility threshold anywhere — there is no motif.
    return reject("fully_transparent", "Bilden är helt genomskinlig — det finns inget motiv att trycka.");
  }
  if (!alpha.hasTransparency) {
    notices.push({
      code: "opaque",
      message:
        "Bilden saknar transparent bakgrund — hela rektangeln trycks, inklusive ev. vit bakgrund. Är motivet en logga? Exportera som PNG med transparens.",
    });
  } else if (alpha.semiRatio > SEMI_NOTICE_RATIO) {
    notices.push({
      code: "semi_transparent",
      message:
        "Motivet innehåller halvgenomskinliga partier (t.ex. skuggor) — de kan se annorlunda ut i tryck på mörka plagg.",
    });
  }

  // ── the preview WebP, from the print PNG ──
  await sharp(out.printPath)
    .resize({ fit: "inside", height: PREVIEW_MAX_EDGE, width: PREVIEW_MAX_EDGE, withoutEnlargement: true })
    .webp({ quality: 70 })
    .toFile(out.previewPath);

  return {
    meta: {
      effectiveDpi,
      heightPx: height,
      maxPrintMm: { h: Math.round(maxPrintMm.h), w: Math.round(maxPrintMm.w) },
      pipelineVersion: PIPELINE_VERSION,
      profileId: profile.id,
      widthPx: width,
    },
    notices,
    ok: true,
  };
}

// Alpha profile of the FINAL png, sampled on a ≤512 px derivative:
//   hasAlphaChannel — the png has an alpha channel at all
//   hasTransparency — a meaningful share of pixels below 250 (the opaque-notice key)
//   semiRatio       — fraction in the 5–95% band (soft shadows/glows)
//   visibleRatio    — fraction ABOVE the visibility threshold; 0 ⇒ no motif at all
async function alphaProfile(path: string): Promise<{
  hasAlphaChannel: boolean;
  hasTransparency: boolean;
  semiRatio: number;
  visibleRatio: number;
}> {
  const meta = await sharp(path).metadata();
  if (!meta.hasAlpha) {
    return { hasAlphaChannel: false, hasTransparency: false, semiRatio: 0, visibleRatio: 1 };
  }
  const { data, info } = await sharp(path)
    .resize({ fit: "inside", height: 512, width: 512, withoutEnlargement: true })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  let below250 = 0;
  let semi = 0;
  let visible = 0;
  for (const a of data) {
    if (a < 250) below250++;
    if (a >= SEMI_LO && a <= SEMI_HI) semi++;
    if (a >= TRIM_THRESHOLD) visible++;
  }
  return {
    hasAlphaChannel: true,
    hasTransparency: total > 0 && below250 / total >= OPAQUE_RATIO,
    semiRatio: total > 0 ? semi / total : 0,
    visibleRatio: total > 0 ? visible / total : 0,
  };
}
