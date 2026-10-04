import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { renderCanvas } from "../src/canvas.ts";
import type { CanvasSpec } from "../src/contract.ts";
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
