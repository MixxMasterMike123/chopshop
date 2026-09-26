import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config.ts";
import { handleControl } from "../src/control.ts";
import type { WorkerStatus } from "../src/worker.ts";

const TOKEN = "t".repeat(32);

describe("readConfig fails closed", () => {
  it("accepts the contract and applies the defaults", () => {
    expect(readConfig({ RENDER_API_URL: "https://api.test", RENDER_FARM_TOKEN: TOKEN })).toStrictEqual({
      config: { apiUrl: "https://api.test", idleExitMs: 120_000, maxConcurrentJobs: 1, token: TOKEN },
      ok: true,
    });
    expect(
      readConfig({
        IDLE_EXIT_SECONDS: "30",
        MAX_CONCURRENT_JOBS: "3",
        RENDER_API_URL: "https://api.test",
        RENDER_FARM_TOKEN: TOKEN,
      }),
    ).toMatchObject({ config: { idleExitMs: 30_000, maxConcurrentJobs: 3 }, ok: true });
  });

  it.each<[string, Record<string, string>]>([
    ["RENDER_API_URL", { RENDER_API_URL: "http://api.test" }],
    ["RENDER_API_URL", { RENDER_API_URL: "https://api.test/" }],
    ["RENDER_API_URL", { RENDER_API_URL: "https://api.test/v1" }],
    ["RENDER_FARM_TOKEN", { RENDER_FARM_TOKEN: "t".repeat(31) }],
    ["RENDER_FARM_TOKEN", { RENDER_FARM_TOKEN: `${"t".repeat(32)} ` }],
    ["IDLE_EXIT_SECONDS", { IDLE_EXIT_SECONDS: "5" }],
    ["IDLE_EXIT_SECONDS", { IDLE_EXIT_SECONDS: "1e3" }],
    ["MAX_CONCURRENT_JOBS", { MAX_CONCURRENT_JOBS: "0" }],
    ["MAX_CONCURRENT_JOBS", { MAX_CONCURRENT_JOBS: "5" }],
  ])("names %s (never its value)", (name, overrides) => {
    const result = readConfig({
      RENDER_API_URL: "https://api.test",
      RENDER_FARM_TOKEN: TOKEN,
      ...overrides,
    });
    expect(result).toStrictEqual({ invalid: [name], ok: false });
  });

  it("names every missing required variable", () => {
    expect(readConfig({})).toStrictEqual({
      invalid: ["RENDER_API_URL", "RENDER_FARM_TOKEN"],
      ok: false,
    });
  });
});

describe("the control surface", () => {
  function fakeWorker(status: Partial<WorkerStatus> = {}) {
    let wakes = 0;
    return {
      get wakes() {
        return wakes;
      },
      status: (): WorkerStatus => ({
        inFlight: 0,
        jobsCompleted: 2,
        jobsFailed: 1,
        leaseHoldMs: 0,
        polling: false,
        stopping: false,
        uptimeMs: 5,
        ...status,
      }),
      wake: () => {
        wakes += 1;
      },
    };
  }

  it("GET /healthz reports what the Durable Object needs to decide on sleep", () => {
    expect(handleControl("GET", "/healthz", fakeWorker({ inFlight: 1, polling: true }))).toStrictEqual({
      body: { inFlight: 1, jobsCompleted: 2, jobsFailed: 1, leaseHoldMs: 0, ok: true, polling: true, uptimeMs: 5 },
      status: 200,
    });
  });

  it("GET /healthz carries the lease hold (Codex P1: the DO must keep a holding container)", () => {
    expect(handleControl("GET", "/healthz", fakeWorker({ leaseHoldMs: 42_000, polling: true })).body).toMatchObject({
      leaseHoldMs: 42_000,
      polling: true,
    });
  });

  it("POST /wake re-arms polling", () => {
    const worker = fakeWorker();
    expect(handleControl("POST", "/wake", worker).status).toBe(200);
    expect(worker.wakes).toBe(1);
  });

  it.each([
    ["GET", "/wake"],
    ["POST", "/healthz"],
    ["GET", "/"],
    ["GET", "/v1/render/jobs/acquire"],
  ])("%s %s is a 404 and wakes nothing", (method, path) => {
    const worker = fakeWorker();
    expect(handleControl(method, path, worker)).toStrictEqual({ body: { error: "not_found" }, status: 404 });
    expect(worker.wakes).toBe(0);
  });
});
