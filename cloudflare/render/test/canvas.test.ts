import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { renderCanvas } from "../src/canvas.ts";
import type { CanvasSpec, FlatCanvasSpec } from "../src/contract.ts";
import { transparentPng } from "./fixtures.ts";

/**
 * CP6-PS2 — the canvas renderer on real sharp: the frame-sized transparent PNG
 * with the motif at the frozen box and offset, its pHYs at the DPI, the same
 * bytes twice, and a refusal for every mismatch.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function setup(input: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "canvas-test-"));
  dirs.push(dir);
  const path = join(dir, "input.png");
  await writeFile(path, input);
  return { dir, path, sha256: createHash("sha256").update(input).digest("hex") };
}

// A 400 × 200 px motif placed at 200 × 100 px in a 1000 × 800 canvas.
const SPEC: CanvasSpec = {
  background: "transparent",
  canvasPx: { h: 800, w: 1_000 },
  dpi: 300,
  motifPx: { h: 100, w: 200 },
  offsetPx: { left: 400, top: 350 },
  sourcePx: { h: 200, w: 400 },
  version: 1,
};

async function alphaAt(path: string, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * info.channels + 3] as number;
}

describe("renderCanvas", () => {
  it("makes the frame-sized RGBA PNG: transparent everywhere but the motif box, pHYs = the DPI", async () => {
    const input = await setup(await transparentPng(400, 200));
    const out = join(input.dir, "canvas.png");
    expect(await renderCanvas(input, SPEC, out)).toEqual({ ok: true });

    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ channels: 4, density: 300, format: "png", height: 800, width: 1_000 });
    // The opaque motif occupies exactly the box [400, 600) × [350, 450).
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    let minX = info.width;
    let minY = info.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if ((data[(y * info.width + x) * 4 + 3] as number) > 0) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    expect({ maxX, maxY, minX, minY }).toEqual({ maxX: 599, maxY: 449, minX: 400, minY: 350 });
    expect(await alphaAt(out, 0, 0)).toBe(0);
    expect(await alphaAt(out, 999, 799)).toBe(0);
    expect(await alphaAt(out, 500, 400)).toBe(255);
  });

  it("an opaque RGB master still gets a transparent frame around it", async () => {
    const rgb = await sharp({ create: { background: { b: 20, g: 120, r: 200 }, channels: 3, height: 200, width: 400 } })
      .png()
      .toBuffer();
    const input = await setup(rgb);
    const out = join(input.dir, "canvas.png");
    expect(await renderCanvas(input, SPEC, out)).toEqual({ ok: true });
    expect((await sharp(out).metadata()).channels).toBe(4);
    expect(await alphaAt(out, 10, 10)).toBe(0);
    expect(await alphaAt(out, 450, 400)).toBe(255);
  });

  it("renders the same bytes twice from the same input and spec", async () => {
    const input = await setup(await transparentPng(400, 200, 0.7));
    const a = join(input.dir, "a.png");
    const b = join(input.dir, "b.png");
    await renderCanvas(input, SPEC, a);
    await renderCanvas(input, SPEC, b);
    const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
    expect(await digest(a)).toBe(await digest(b));
  });

  it("refuses a file that is not the frozen master (input_mismatch), before decoding it", async () => {
    const input = await setup(await transparentPng(400, 200));
    expect(await renderCanvas({ ...input, sha256: "0".repeat(64) }, SPEC, join(input.dir, "x.png"))).toMatchObject({
      ok: false,
      reasons: [{ code: "input_mismatch" }],
    });
  });

  it("refuses a master whose pixels are not the frozen ones (dims_mismatch)", async () => {
    const input = await setup(await transparentPng(401, 200));
    expect(await renderCanvas(input, SPEC, join(input.dir, "x.png"))).toMatchObject({
      ok: false,
      reasons: [{ code: "dims_mismatch" }],
    });
  });

  it("refuses a motif that would not fit (motif_exceeds_canvas), never cropping it", async () => {
    const input = await setup(await transparentPng(400, 200));
    expect(
      await renderCanvas(input, { ...SPEC, offsetPx: { left: 900, top: 350 } }, join(input.dir, "x.png")),
    ).toMatchObject({ ok: false, reasons: [{ code: "motif_exceeds_canvas" }] });
  });
});

describe("CP12: a flat (poster) canvas", () => {
  // A 400 × 200 master on a 300 × 400 sheet.
  const CONTAIN: FlatCanvasSpec = {
    background: "#ff0000",
    canvasPx: { h: 400, w: 300 },
    dpi: 300,
    fit: "contain",
    motifPx: { h: 150, w: 300 },
    offsetPx: { left: 0, top: 125 },
    sourceCropPx: { h: 200, left: 0, top: 0, w: 400 },
    sourcePx: { h: 200, w: 400 },
    version: 1,
  };

  async function pixel(path: string, x: number, y: number): Promise<number[]> {
    const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    const at = (y * info.width + x) * info.channels;
    return Array.from(data.subarray(at, at + info.channels));
  }

  it("contain: the sheet's exact pixels, opaque RGB, the background around the motif, pHYs = the DPI", async () => {
    const rgb = await sharp({ create: { background: { b: 200, g: 20, r: 10 }, channels: 3, height: 200, width: 400 } })
      .png()
      .toBuffer();
    const input = await setup(rgb);
    const out = join(input.dir, "poster.png");
    expect(await renderCanvas(input, CONTAIN, out)).toEqual({ ok: true });
    expect(await sharp(out).metadata()).toMatchObject({ channels: 3, density: 300, format: "png", height: 400, width: 300 });
    expect(await pixel(out, 150, 10)).toEqual([255, 0, 0]);
    expect(await pixel(out, 150, 390)).toEqual([255, 0, 0]);
    expect(await pixel(out, 150, 200)).toEqual([10, 20, 200]);
  });

  it("contain: a transparent master's transparency becomes the background (no alpha channel left)", async () => {
    const input = await setup(await transparentPng(400, 200, 0.5));
    const out = join(input.dir, "poster.png");
    expect(await renderCanvas(input, { ...CONTAIN, background: "#ffffff" }, out)).toEqual({ ok: true });
    expect((await sharp(out).metadata()).channels).toBe(3);
    // Inside the motif box but outside the motif's opaque half: white.
    expect(await pixel(out, 10, 140)).toEqual([255, 255, 255]);
    const centre = await pixel(out, 150, 200);
    expect(centre[0]).toBeGreaterThan(200);
    expect(centre[1]).toBeLessThan(60);
  });

  it("cover: the frozen centre crop fills the whole sheet", async () => {
    // Left half blue, right half green: a centred crop of the 400 × 200 master
    // to the sheet's 3:4 is 150 × 200 at x = 125, which straddles the seam.
    const half = await sharp({ create: { background: { b: 0, g: 255, r: 0 }, channels: 3, height: 200, width: 200 } })
      .png()
      .toBuffer();
    const master = await sharp({ create: { background: { b: 255, g: 0, r: 0 }, channels: 3, height: 200, width: 400 } })
      .composite([{ input: half, left: 200, top: 0 }])
      .png()
      .toBuffer();
    const input = await setup(master);
    const out = join(input.dir, "poster.png");
    const cover: FlatCanvasSpec = {
      ...CONTAIN,
      canvasPx: { h: 200, w: 150 },
      fit: "cover",
      motifPx: { h: 200, w: 150 },
      offsetPx: { left: 0, top: 0 },
      sourceCropPx: { h: 200, left: 125, top: 0, w: 150 },
    };
    expect(await renderCanvas(input, cover, out)).toEqual({ ok: true });
    expect(await sharp(out).metadata()).toMatchObject({ channels: 3, height: 200, width: 150 });
    expect(await pixel(out, 5, 100)).toEqual([0, 0, 255]);
    expect(await pixel(out, 145, 100)).toEqual([0, 255, 0]);
  });

  it("refuses a crop outside the master and a master that is not the frozen one", async () => {
    const input = await setup(await transparentPng(400, 200));
    expect(
      await renderCanvas(input, { ...CONTAIN, sourceCropPx: { h: 200, left: 1, top: 0, w: 400 } }, join(input.dir, "x.png")),
    ).toMatchObject({ ok: false, reasons: [{ code: "motif_exceeds_canvas" }] });
    expect(await renderCanvas({ ...input, sha256: "0".repeat(64) }, CONTAIN, join(input.dir, "y.png"))).toMatchObject({
      ok: false,
      reasons: [{ code: "input_mismatch" }],
    });
  });
});
