/**
 * Pipeline benchmark — the compute half of docs/cf-port/RENDER_BENCHMARK.md.
 *
 *   node --experimental-strip-types bench/bench.ts --fixture largest --jobs 3 --parallel 1
 *
 * Runs the REAL pipeline (src/pipeline.ts) on a synthetic fixture, `jobs` times with
 * at most `parallel` at once, then streams each output through sha256 the way the
 * PUT does. Prints one JSON line per job and a summary line: wall time per job, the
 * drain time of the whole batch, and the peak resident memory (sampled every 50 ms,
 * plus the kernel high-water mark where /proc exists). No network.
 *
 * Fixtures (cached under BENCH_DIR, default the OS temp dir):
 *   largest — 10 000 × 10 000 px RGBA PNG (the pipeline's pixel ceiling, spec §8)
 *             with a 200 px transparent border (so the trim does real work) and a
 *             noisy band (1 500 rows ≈ 45 MB) sized to keep the file under the 50 MB profile cap (a
 *             larger file never reaches the decoder: the size gate rejects it).
 *   typical — 3 600 × 3 600 px RGBA PNG, 0.9 motif (a realistic passing upload).
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import type { JobProfile } from "../src/contract.ts";
import { memorySnapshotMb, resetPeakRss } from "../src/metrics.ts";
import { runArtworkPipeline } from "../src/pipeline.ts";

const PROFILE: JobProfile = {
  accepted_formats: [{ ext: "png" }, { ext: "jpg" }, { ext: "tiff" }, { ext: "webp" }],
  id: "front_a3",
  max_file_mb: 50,
  min_dpi: 300,
  print_area_mm: { h: 350, w: 250 },
};

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

async function makeFixture(kind: string, path: string): Promise<void> {
  if (kind === "typical") {
    const motif = await sharp({
      create: { background: { alpha: 1, b: 40, g: 30, r: 220 }, channels: 4, height: 3240, width: 3240 },
    })
      .png()
      .toBuffer();
    await sharp({ create: { background: { alpha: 0, b: 0, g: 0, r: 0 }, channels: 4, height: 3600, width: 3600 } })
      .composite([{ input: motif, left: 180, top: 180 }])
      .png()
      .toFile(path);
    return;
  }
  const side = 10_000;
  const border = 200;
  const motifSide = side - 2 * border;
  const bandHeight = Number(arg("band", "1500"));
  const noise = await sharp({
    create: { background: { b: 128, g: 128, r: 128 }, channels: 3, height: bandHeight, noise: { mean: 128, sigma: 30, type: "gaussian" }, width: motifSide },
  })
    .ensureAlpha(1)
    .png({ compressionLevel: 1 })
    .toBuffer();
  const base = await sharp({
    create: { background: { alpha: 1, b: 90, g: 60, r: 30 }, channels: 4, height: motifSide, width: motifSide },
  })
    .composite([{ input: noise, left: 0, top: Math.floor((motifSide - bandHeight) / 2) }])
    .png()
    .toBuffer();
  await sharp({ create: { background: { alpha: 0, b: 0, g: 0, r: 0 }, channels: 4, height: side, width: side } })
    .composite([{ input: base, left: border, top: border }])
    .png()
    .toFile(path);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const kind = arg("fixture", "largest");
const jobs = Number(arg("jobs", "1"));
const parallel = Number(arg("parallel", "1"));
const benchDir = process.env.BENCH_DIR ?? tmpdir();
await mkdir(benchDir, { recursive: true });
const fixture = join(benchDir, `render-bench-${kind}.png`);

if (!existsSync(fixture)) {
  const started = Date.now();
  await makeFixture(kind, fixture);
  console.log(JSON.stringify({ event: "fixture_written", kind, ms: Date.now() - started }));
}
const { size: inputBytes } = await stat(fixture);
const inputMeta = await sharp(fixture).metadata();

let sampledPeakMb = 0;
const sampler = setInterval(() => {
  sampledPeakMb = Math.max(sampledPeakMb, Math.round(process.memoryUsage.rss() / 1024 / 1024));
}, 50);
const baselineRssMb = Math.round(process.memoryUsage.rss() / 1024 / 1024);
resetPeakRss();

const work = await mkdtemp(join(tmpdir(), "render-bench-run-"));
const walls: number[] = [];
const drainStarted = Date.now();
let next = 0;

async function lane(): Promise<void> {
  while (next < jobs) {
    const index = next;
    next += 1;
    const out = {
      previewPath: join(work, `preview-${index}.webp`),
      printPath: join(work, `print-${index}.png`),
    };
    const started = Date.now();
    const result = await runArtworkPipeline({ bytes: inputBytes, path: fixture }, PROFILE, out);
    const pipelineMs = Date.now() - started;
    let printBytes = 0;
    if (result.ok) {
      printBytes = (await stat(out.printPath)).size;
      await sha256File(out.printPath);
      await sha256File(out.previewPath);
    }
    const wallMs = Date.now() - started;
    walls.push(wallMs);
    console.log(
      JSON.stringify({
        event: "job",
        index,
        ok: result.ok,
        codes: result.ok ? result.notices.map((n) => n.code) : result.reasons.map((r) => r.code),
        pipelineMs,
        printBytes,
        wallMs,
      }),
    );
    await rm(out.printPath, { force: true });
    await rm(out.previewPath, { force: true });
  }
}

await Promise.all(Array.from({ length: Math.min(parallel, jobs) }, () => lane()));
clearInterval(sampler);
await rm(work, { force: true, recursive: true });

const sorted = [...walls].sort((a, b) => a - b);
console.log(
  JSON.stringify({
    event: "summary",
    fixture: kind,
    inputBytes,
    inputPx: `${inputMeta.width}x${inputMeta.height}`,
    jobs,
    parallel,
    drainMs: Date.now() - drainStarted,
    wallMsMin: sorted[0],
    wallMsMedian: sorted[Math.floor(sorted.length / 2)],
    wallMsMax: sorted[sorted.length - 1],
    baselineRssMb,
    sampledPeakRssMb: sampledPeakMb,
    // VmHWM on Linux (reset above); process-lifetime maxRSS elsewhere.
    kernelPeakRssMb: memorySnapshotMb().peakRssMb,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips,
  }),
);
