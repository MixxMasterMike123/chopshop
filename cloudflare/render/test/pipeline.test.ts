import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JobProfile } from "../src/contract.ts";
import { PIPELINE_VERSION, runArtworkPipeline } from "../src/pipeline.ts";
import { opaqueJpeg, PROFILE, transparentPng } from "./fixtures.ts";

/**
 * The behaviour pin for the ported pipeline. Expectations come from the SPEC and
 * the gate math, computed by hand in the comments — not recorded from a run — so a
 * wrong port fails instead of being blessed. Cases (1)–(6) are the old farm's own
 * pins; the rest cover the boundary, contain on the height axis, the notices and
 * the byte parity of the file-based I/O.
 */

const MM_PER_INCH = 25.4;
let dir = "";
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "render-pipeline-test-"));
});

afterAll(async () => {
  await rm(dir, { force: true, recursive: true });
});

async function run(bytes: Buffer, profile: JobProfile = PROFILE) {
  counter += 1;
  const path = join(dir, `input-${counter}`);
  await writeFile(path, bytes);
  const out = {
    previewPath: join(dir, `preview-${counter}.webp`),
    printPath: join(dir, `print-${counter}.png`),
  };
  const result = await runArtworkPipeline({ bytes: bytes.length, path }, profile, out);
  return { out, result };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("the gate — fits / does not fit at 300 DPI", () => {
  it("(1) 3200×3200 PNG passes with the measured facts", async () => {
    // Contain into 250×350: aspect 1 ⇒ w = min(250, 350) = 250 mm.
    // effectiveDpi = round(3200 / (250/25.4)) = round(325.12) = 325 ≥ 300.
    // The motif fills the canvas edge to edge, so the PNG has an alpha channel but
    // no transparent pixel: spec §4 "PNG med alfakanal men 100% opak → INFORMERA".
    const { out, result } = await run(await transparentPng(3200, 3200));
    expect(result).toStrictEqual({
      meta: {
        effectiveDpi: 325,
        heightPx: 3200,
        maxPrintMm: { h: 250, w: 250 },
        pipelineVersion: PIPELINE_VERSION,
        profileId: "front_a3",
        widthPx: 3200,
      },
      notices: [
        {
          code: "opaque",
          message:
            "Bilden saknar transparent bakgrund — hela rektangeln trycks, inklusive ev. vit bakgrund. Är motivet en logga? Exportera som PNG med transparens.",
        },
      ],
      ok: true,
    });

    // The printer needs transparency: alpha must survive the re-encode.
    const print = await sharp(out.printPath).metadata();
    expect([print.format, print.hasAlpha, print.width, print.height]).toStrictEqual(["png", true, 3200, 3200]);
    // Preview: WebP, longest edge ≤ 800.
    const preview = await sharp(out.previewPath).metadata();
    expect(preview.format).toBe("webp");
    expect(Math.max(preview.width ?? 0, preview.height ?? 0)).toBe(800);
  });

  it("(2) 900×900 rejects with resolution_too_low and the promised numbers", async () => {
    // effectiveDpi = round(900 / 9.8425) = 91; requiredPx = round(250/25.4 × 300) = 2953.
    const { result } = await run(await transparentPng(900, 900));
    expect(result).toStrictEqual({
      ok: false,
      reasons: [
        {
          code: "resolution_too_low",
          message:
            "Motivet är 900 × 900 px. I sin största tryckstorlek 25 × 25 cm blir det 91 DPI — " +
            "minimikravet är 300 DPI. För din bilds proportioner krävs minst 2953 × 2953 px. " +
            "Exportera om från originalet i full storlek — uppskalning i efterhand hjälper inte.",
        },
      ],
    });
  });

  it("rounds at the boundary: 2948 px passes (299.52 → 300), 2947 px fails (299.42 → 299)", async () => {
    // 250 mm = 9.8425197 in. 2948 / 9.8425197 = 299.52; 2947 / 9.8425197 = 299.42.
    const fits = await run(await transparentPng(2948, 2948));
    expect(fits.result.ok).toBe(true);
    expect(fits.result.ok && fits.result.meta.effectiveDpi).toBe(300);

    const misses = await run(await transparentPng(2947, 2947));
    expect(misses.result.ok).toBe(false);
    expect(!misses.result.ok && misses.result.reasons[0]?.message).toContain("blir det 299 DPI");
  });

  it("contains on the HEIGHT axis for a tall motif (1600×4800 ⇒ 117 × 350 mm, 348 DPI)", async () => {
    // aspect 1/3 ⇒ w = min(250, 350/3 = 116.67) mm; dpi = round(1600 / (116.67/25.4)) = round(348.3).
    const { result } = await run(await transparentPng(1600, 4800));
    expect(result.ok && result.meta).toStrictEqual({
      effectiveDpi: 348,
      heightPx: 4800,
      maxPrintMm: { h: 350, w: 117 },
      pipelineVersion: PIPELINE_VERSION,
      profileId: "front_a3",
      widthPx: 1600,
    });
  });

  it("gates the TRIMMED motif: 0.9 of 3200 = 2880 px ⇒ 293 DPI ⇒ rejected", async () => {
    // round(2880 / 9.8425) = round(292.6) = 293 < 300.
    const { result } = await run(await transparentPng(3200, 3200, 0.9));
    expect(!result.ok && result.reasons[0]?.message).toContain("Motivet är 2880 × 2880 px");
  });
});

describe("byte, pixel and format gates", () => {
  it("(3) a file over max_file_mb rejects with file_too_large before decoding", async () => {
    const src = await transparentPng(3200, 3200);
    const mb = src.length / 1024 / 1024;
    const { result } = await run(src, { ...PROFILE, max_file_mb: 0.01 });
    expect(result).toStrictEqual({
      ok: false,
      reasons: [{ code: "file_too_large", message: `Filen är ${mb.toFixed(1)} MB — max 0.01 MB.` }],
    });
  });

  it("(4) identifies by CONTENT: a WebP against a PNG-only profile is format_not_accepted", async () => {
    const webp = await sharp({
      create: { background: { alpha: 1, b: 10, g: 10, r: 10 }, channels: 4, height: 3200, width: 3200 },
    })
      .webp()
      .toBuffer();
    const { result } = await run(webp, { ...PROFILE, accepted_formats: [{ ext: "png" }] });
    expect(result).toStrictEqual({
      ok: false,
      reasons: [{ code: "format_not_accepted", message: "Formatet .webp stöds inte. Tillåtna format: PNG." }],
    });
  });

  it("rejects a GIF with its dedicated message", async () => {
    const gif = await sharp({
      create: { background: { b: 0, g: 0, r: 255 }, channels: 3, height: 64, width: 64 },
    })
      .gif()
      .toBuffer();
    const { result } = await run(gif);
    expect(!result.ok && result.reasons[0]?.code).toBe("format_gif");
  });

  it("rejects over 10 000 px on the longest side with px_too_large (header read only)", async () => {
    const wide = await sharp({
      create: { background: { alpha: 1, b: 0, g: 0, r: 0 }, channels: 4, height: 8, width: 10_001 },
    })
      .png()
      .toBuffer();
    const { result } = await run(wide);
    expect(result).toStrictEqual({
      ok: false,
      reasons: [
        {
          code: "px_too_large",
          message: "Bilden är 10001 × 8 px — max 10000 px på längsta sidan. Skala ner filen.",
        },
      ],
    });
  });

  it("gives an HEIC the iPhone message even though it cannot be decoded", async () => {
    const fake = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypheic", "ascii"),
      Buffer.alloc(64, 7),
    ]);
    const { result } = await run(fake);
    expect(!result.ok && result.reasons[0]?.code).toBe("format_heic");
  });

  it("calls garbage unreadable", async () => {
    const { result } = await run(Buffer.from("this is not an image at all, just text"));
    expect(!result.ok && result.reasons[0]?.code).toBe("unreadable");
  });
});

describe("transparency is inform-only; colour is normalized", () => {
  it("(5) an opaque JPEG PASSES with the `opaque` notice and comes out as PNG", async () => {
    const { out, result } = await run(await opaqueJpeg(3200, 3200));
    expect(result.ok).toBe(true);
    expect(result.ok && result.notices.map((notice) => notice.code)).toStrictEqual(["opaque"]);
    expect(result.ok && result.notices[0]?.message).toContain("saknar transparent bakgrund");
    expect((await sharp(out.printPath).metadata()).format).toBe("png");
  });

  it("(5b) trims transparent margins to the motif and says so", async () => {
    const { result } = await run(await transparentPng(4000, 4000, 0.8));
    expect(result.ok && [result.meta.widthPx, result.meta.heightPx]).toStrictEqual([3200, 3200]);
    expect(result.ok && result.notices.map((notice) => notice.code)).toStrictEqual([
      "trimmed",
      // After the trim the (solid) motif IS the whole canvas.
      "opaque",
    ]);
    expect(result.ok && result.notices[0]?.message).toBe(
      "Genomskinliga marginaler beskars automatiskt (4000 × 4000 → 3200 × 3200 px) så att måtten gäller själva motivet.",
    );
  });

  it("a motif with real transparency inside its bounds passes with no notice at all", async () => {
    // Two solid squares in opposite corners: the trim box is the whole canvas and
    // ~80% of it stays fully transparent — the printer's ideal file.
    const square = await sharp({
      create: { background: { alpha: 1, b: 40, g: 30, r: 220 }, channels: 4, height: 1000, width: 1000 },
    })
      .png()
      .toBuffer();
    const src = await sharp({
      create: { background: { alpha: 0, b: 0, g: 0, r: 0 }, channels: 4, height: 3200, width: 3200 },
    })
      .composite([
        { input: square, left: 0, top: 0 },
        { input: square, left: 2200, top: 2200 },
      ])
      .png()
      .toBuffer();
    const { result } = await run(src);
    expect(result.ok && result.notices).toStrictEqual([]);
    expect(result.ok && result.meta.effectiveDpi).toBe(325);
  });

  it("(5c) a fully transparent image has no motif and is rejected", async () => {
    const empty = await sharp({
      create: { background: { alpha: 0, b: 0, g: 0, r: 0 }, channels: 4, height: 3200, width: 3200 },
    })
      .png()
      .toBuffer();
    const { result } = await run(empty);
    expect(!result.ok && result.reasons[0]?.code).toBe("fully_transparent");
  });

  it("flags a half-transparent motif (shadows/glow) with semi_transparent", async () => {
    const { result } = await run(await transparentPng(3200, 3200, 1, 128));
    expect(result.ok && result.notices.map((notice) => notice.code)).toStrictEqual(["semi_transparent"]);
  });

  it("converts CMYK to sRGB and says so", async () => {
    const cmyk = await sharp({
      create: { background: { b: 40, g: 120, r: 200 }, channels: 3, height: 3200, width: 3200 },
    })
      .toColourspace("cmyk")
      .jpeg()
      .toBuffer();
    expect((await sharp(cmyk).metadata()).space).toBe("cmyk");

    const { out, result } = await run(cmyk);
    expect(result.ok && result.notices.map((notice) => notice.code)).toStrictEqual([
      "cmyk_converted",
      "opaque",
    ]);
    expect((await sharp(out.printPath).metadata()).space).toBe("srgb");
  });
});

describe("determinism and parity", () => {
  it("(6) the same input twice gives byte-identical outputs", async () => {
    // 3600 × 0.9 = 3240 px ⇒ round(329.2) = 329 DPI: passes after the trim.
    const src = await transparentPng(3600, 3600, 0.9);
    const a = await run(src);
    const b = await run(src);
    expect(a.result).toStrictEqual(b.result);
    expect(sha256(await readFile(a.out.printPath))).toBe(sha256(await readFile(b.out.printPath)));
    expect(sha256(await readFile(a.out.previewPath))).toBe(sha256(await readFile(b.out.previewPath)));
  });

  it("writes the SAME bytes the old farm's all-in-memory pipeline produced", async () => {
    // The only divergence from the farm is file I/O instead of Buffers. This is
    // the farm's own encode chain, run on Buffers, as the reference.
    const src = await transparentPng(4000, 4000, 0.8);
    const reference = await sharp(src)
      .rotate()
      .trim({ background: { alpha: 0, b: 0, g: 0, r: 0 }, threshold: 13 })
      .toColourspace("srgb")
      .png()
      .toBuffer();
    const referencePreview = await sharp(reference)
      .resize({ fit: "inside", height: 800, width: 800, withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();

    const { out } = await run(src);
    expect(sha256(await readFile(out.printPath))).toBe(sha256(reference));
    expect(sha256(await readFile(out.previewPath))).toBe(sha256(referencePreview));

    const jpeg = await opaqueJpeg(3000, 3000);
    const jpegReference = await sharp(jpeg).rotate().toColourspace("srgb").png().toBuffer();
    const opaque = await run(jpeg);
    expect(sha256(await readFile(opaque.out.printPath))).toBe(sha256(jpegReference));
  });

  it("measures in DISPLAY orientation (EXIF 6 swaps the axes)", async () => {
    // Stored 4800 wide × 1600 high, EXIF orientation 6 (rotate 90°) ⇒ displayed
    // 1600 × 4800 — the tall case above, so the same 348 DPI.
    const stored = await sharp({
      create: { background: { b: 60, g: 180, r: 200 }, channels: 3, height: 1600, width: 4800 },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(stored).metadata()).orientation).toBe(6);

    const { result } = await run(stored);
    expect(result.ok && [result.meta.widthPx, result.meta.heightPx, result.meta.effectiveDpi]).toStrictEqual([
      1600, 4800, 348,
    ]);
  });
});
