import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import type { AcquireResult, ReportStatus } from "../src/api.ts";
import type { Logger, LogValue } from "../src/log.ts";
import type { runArtworkPipeline } from "../src/pipeline.ts";
import { RenderWorker } from "../src/worker.ts";
import { leaseBody, PROFILE, transparentPng } from "./fixtures.ts";

/**
 * The loop and the job runner, end to end in-process: a fake API (acquire / report)
 * and a fake R2 (the presigned GET and PUTs) behind injected functions — no socket.
 * The pipeline is the real one unless a case swaps it.
 */

const TOKEN = "never-log-this-render-farm-token-0123456789";

interface Report {
  action: "complete" | "fail";
  body: Record<string, unknown>;
  jobId: string;
}

function fakeApi(leases: unknown[], statusFor: (report: Report) => ReportStatus = () => 200) {
  const reports: Report[] = [];
  let acquires = 0;
  return {
    api: {
      async acquire(): Promise<AcquireResult> {
        acquires += 1;
        const next = leases.shift();
        return next === undefined ? { kind: "empty" } : { body: next, kind: "lease" };
      },
      async report(jobId: string, action: "complete" | "fail", body: unknown): Promise<ReportStatus> {
        const report = { action, body: body as Record<string, unknown>, jobId };
        reports.push(report);
        return statusFor(report);
      },
    },
    get acquires() {
      return acquires;
    },
    reports,
  };
}

function fakeR2(input: Buffer, options: { getStatus?: number; putStatus?: number } = {}) {
  const puts = new Map<string, { bytes: Buffer; headers: Record<string, string> }>();
  let gets = 0;
  return {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const path = new URL(url).pathname;
      if (init?.method === "GET") {
        gets += 1;
        return options.getStatus === undefined
          ? new Response(input, { headers: { "content-length": String(input.length) } })
          : new Response("no", { status: options.getStatus });
      }
      const bytes = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
      puts.set(path.slice(path.indexOf("/pod/") + 1), {
        bytes,
        headers: init?.headers as Record<string, string>,
      });
      return new Response(null, { status: options.putStatus ?? 200 });
    },
    get gets() {
      return gets;
    },
    puts,
  };
}

function recorder() {
  const lines: string[] = [];
  const log: Logger = (level, event, fields: Record<string, LogValue>) => {
    lines.push(JSON.stringify({ event, level, ...fields }));
  };
  return { lines, log };
}

const workers: RenderWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

function start(
  api: ReturnType<typeof fakeApi>["api"],
  r2: { fetch: (url: string, init?: RequestInit) => Promise<Response> },
  options: { idleExitMs?: number; log?: Logger; maxConcurrentJobs?: number; runPipeline?: typeof runArtworkPipeline } = {},
): RenderWorker {
  const worker = new RenderWorker({
    api,
    fetch: r2.fetch,
    idleExitMs: options.idleExitMs ?? 60_000,
    log: options.log ?? (() => undefined),
    maxConcurrentJobs: options.maxConcurrentJobs ?? 1,
    pollIntervalMs: 2,
    ...(options.runPipeline === undefined ? {} : { runPipeline: options.runPipeline }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  });
  workers.push(worker);
  worker.wake();
  return worker;
}

async function until(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("a job, end to end", () => {
  it("downloads, gates, PUTs both outputs and completes with exactly what it PUT", async () => {
    const input = await transparentPng(3200, 3200);
    const lease = leaseBody({ input: { maxBytes: input.length, url: (leaseBody().input as { url: string }).url } });
    const api = fakeApi([lease]);
    const r2 = fakeR2(input);
    const { lines, log } = recorder();
    start(api.api, r2, { log });

    await until(() => api.reports.length === 1);
    const [report] = api.reports;
    expect(report?.action).toBe("complete");
    expect(report?.jobId).toBe(lease.jobId);

    const prefix = lease.outputPrefix as string;
    const print = r2.puts.get(`${prefix}print.png`);
    const preview = r2.puts.get(`${prefix}preview.webp`);
    expect(print?.headers["content-type"]).toBe("image/png");
    expect(preview?.headers["content-type"]).toBe("image/webp");

    const body = report?.body ?? {};
    expect(Object.keys(body).sort()).toStrictEqual([
      "attempt", "fields", "leaseToken", "metrics", "notices", "ok", "outputs",
    ]);
    expect(body.attempt).toBe(1);
    expect(body.leaseToken).toBe(lease.leaseToken);
    expect(body.ok).toBe(true);
    expect(body.fields).toStrictEqual({
      effectiveDpi: 325,
      heightPx: 3200,
      maxPrintMm: { h: 250, w: 250 },
      pipelineVersion: 1,
      profileId: "front_a3",
      widthPx: 3200,
    });
    expect(body.outputs).toStrictEqual({
      previewWebp: { bytes: preview?.bytes.length, key: `${prefix}preview.webp`, sha256: sha(preview?.bytes ?? Buffer.alloc(0)) },
      printPng: { bytes: print?.bytes.length, key: `${prefix}print.png`, sha256: sha(print?.bytes ?? Buffer.alloc(0)) },
    });

    const metrics = body.metrics as Record<string, number>;
    for (const key of ["fetchMs", "pipelineMs", "uploadMs", "wallMs", "peakRssMb", "rssMb", "inputBytes", "printBytes", "previewBytes"]) {
      expect(Number.isFinite(metrics[key]), key).toBe(true);
    }
    expect(metrics.inputBytes).toBe(input.length);

    // The logs name the job and its numbers and nothing that grants anything.
    const logged = lines.join("\n");
    expect(logged).toContain(lease.jobId as string);
    expect(logged).not.toContain("r2.cloudflarestorage.com");
    expect(logged).not.toContain("X-Amz");
    expect(logged).not.toContain(lease.leaseToken as string);
    expect(logged).not.toContain(TOKEN);
  });

  it("completes a gate REJECTION with the Swedish reasons and PUTs nothing", async () => {
    const input = await transparentPng(900, 900);
    const api = fakeApi([leaseBody()]);
    const r2 = fakeR2(input);
    start(api.api, r2);

    await until(() => api.reports.length === 1);
    expect(api.reports[0]?.action).toBe("complete");
    expect(api.reports[0]?.body.ok).toBe(false);
    expect((api.reports[0]?.body.reasons as Array<{ code: string }>)[0]?.code).toBe("resolution_too_low");
    expect(r2.puts.size).toBe(0);
  });

  it("gives an original over the profile's max_file_mb the file_too_large VERDICT, not a job failure", async () => {
    // input.maxBytes is the original's recorded size, so the download is allowed;
    // the profile's 1 MB is enforced by the pipeline's own size gate.
    const input = Buffer.alloc(1_500_000, 1);
    const api = fakeApi([
      leaseBody({
        input: { maxBytes: input.length, url: (leaseBody().input as { url: string }).url },
        profile: { ...PROFILE, max_file_mb: 1 },
      }),
    ]);
    start(api.api, fakeR2(input));

    await until(() => api.reports.length === 1);
    expect(api.reports[0]?.body).toMatchObject({
      ok: false,
      reasons: [{ code: "file_too_large", message: "Filen är 1.4 MB — max 1 MB." }],
    });
  });
});

describe("failures are reported as codes", () => {
  it.each<[string, { getStatus?: number; putStatus?: number }, number, string]>([
    ["a refused input GET", { getStatus: 403 }, 4_000_000, "input_fetch_failed"],
    ["an input larger than the job's bound", {}, 10, "input_too_large"],
    ["a refused output PUT", { putStatus: 403 }, 4_000_000, "output_put_failed"],
  ])("%s → fail %s", async (_label, r2Options, maxBytes, code) => {
    const input = await transparentPng(3200, 3200);
    const lease = leaseBody({ input: { maxBytes, url: (leaseBody().input as { url: string }).url } });
    const api = fakeApi([lease]);
    start(api.api, fakeR2(input, r2Options));

    await until(() => api.reports.length === 1);
    expect(api.reports[0]).toStrictEqual({
      action: "fail",
      body: { attempt: 1, error: code, leaseToken: lease.leaseToken },
      jobId: lease.jobId,
    });
  });

  it("a pipeline crash → fail pipeline_crashed", async () => {
    const api = fakeApi([leaseBody()]);
    start(api.api, fakeR2(Buffer.alloc(10)), {
      runPipeline: async () => {
        throw new RangeError("libvips exploded");
      },
    });
    await until(() => api.reports.length === 1);
    expect(api.reports[0]?.body.error).toBe("pipeline_crashed");
  });

  it("a malformed envelope with an intact claim → fail invalid_envelope, nothing fetched", async () => {
    const r2 = fakeR2(Buffer.alloc(10));
    const api = fakeApi([leaseBody({ contract: 99 })]);
    start(api.api, r2);
    await until(() => api.reports.length === 1);
    expect(api.reports[0]?.body.error).toBe("invalid_envelope");
    expect(r2.gets).toBe(0);
  });

  it("an envelope without even a claim is dropped (the lease expiry takes over)", async () => {
    const r2 = fakeR2(Buffer.alloc(10));
    const api = fakeApi([{ jobId: "nope" }]);
    const { lines, log } = recorder();
    start(api.api, r2, { log });
    await until(() => lines.some((line) => line.includes("job_envelope_unusable")));
    expect(api.reports).toStrictEqual([]);
    expect(r2.gets).toBe(0);
  });

  it("a completion the API refuses (400) is followed by fail completion_invalid", async () => {
    const api = fakeApi([leaseBody()], (report) => (report.action === "complete" ? 400 : 200));
    start(api.api, fakeR2(await transparentPng(900, 900)));
    await until(() => api.reports.length === 2);
    expect(api.reports.map((report) => report.action)).toStrictEqual(["complete", "fail"]);
    expect(api.reports[1]?.body.error).toBe("completion_invalid");
  });

  it("a 409 (lease lost) is final: no fail follows", async () => {
    const api = fakeApi([leaseBody()], () => 409);
    const { lines, log } = recorder();
    start(api.api, fakeR2(await transparentPng(900, 900)), { log });
    await until(() => lines.some((line) => line.includes("report_complete")));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.reports.map((report) => report.action)).toStrictEqual(["complete"]);
  });
});

describe("the loop", () => {
  it("stops polling after the idle window and re-arms on wake()", async () => {
    const api = fakeApi([]);
    const { lines, log } = recorder();
    const worker = start(api.api, fakeR2(Buffer.alloc(0)), { idleExitMs: 40, log });

    await until(() => !worker.status().polling);
    expect(lines.some((line) => line.includes("polling_idle_exit"))).toBe(true);
    const afterIdle = api.acquires;
    expect(afterIdle).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.acquires).toBe(afterIdle);

    worker.wake();
    expect(worker.status().polling).toBe(true);
    await until(() => api.acquires > afterIdle);
  });

  it("never runs more than MAX_CONCURRENT_JOBS at once", async () => {
    const leases = Array.from({ length: 5 }, () => leaseBody());
    const api = fakeApi(leases);
    let running = 0;
    let peak = 0;
    start(api.api, fakeR2(Buffer.alloc(10)), {
      maxConcurrentJobs: 2,
      runPipeline: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return { ok: false, reasons: [{ code: "x", message: "y" }] };
      },
    });
    await until(() => api.reports.length === 5);
    expect(peak).toBe(2);
  });

  it("stop() lets the job in flight report before it resolves", async () => {
    const api = fakeApi([leaseBody()]);
    let release: () => void = () => undefined;
    const worker = start(api.api, fakeR2(Buffer.alloc(10)), {
      runPipeline: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, reasons: [{ code: "x", message: "y" }] });
        }),
    });
    await until(() => worker.status().inFlight === 1);
    const stopped = worker.stop();
    release();
    await stopped;
    expect(api.reports).toHaveLength(1);
    expect(worker.status().polling).toBe(false);
  });
});
