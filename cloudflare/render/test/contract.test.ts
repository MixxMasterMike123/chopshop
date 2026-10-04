import { describe, expect, it } from "vitest";

import {
  ACQUIRE_BODY,
  CANVAS_JOB_TYPE,
  CANVAS_MAX_INPUT_BYTES,
  canvasCompletionBody,
  canvasOutputKey,
  canvasReportPath,
  completionBody,
  failureBody,
  isAllowedStorageUrl,
  JOB_TYPE,
  leaseJobType,
  parseCanvasLease,
  parseLease,
  sanitizeMetrics,
  type RenderLease,
} from "../src/contract.ts";
import { leaseBody, PROFILE } from "./fixtures.ts";

describe("the storage host allowlist", () => {
  it.each([
    ["https://acct.r2.cloudflarestorage.com/b/k?X-Amz-Signature=s", true],
    ["https://acct.eu.r2.cloudflarestorage.com/b/k", true],
    ["http://acct.r2.cloudflarestorage.com/b/k", false],
    ["https://evil.test/?x=.r2.cloudflarestorage.com", false],
    ["https://r2.cloudflarestorage.com.evil.test/b/k", false],
    ["https://user:pw@acct.r2.cloudflarestorage.com/b/k", false],
    ["https://169.254.169.254/latest/meta-data", false],
    ["not a url", false],
    [42, false],
  ])("%s → %s", (url, allowed) => {
    expect(isAllowedStorageUrl(url)).toBe(allowed);
  });
});

describe("parseLease", () => {
  it("accepts the API's acquire body and keeps exactly what a job needs", () => {
    const body = leaseBody();
    const parsed = parseLease(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.lease).toStrictEqual({
      attempt: 1,
      inputMaxBytes: 4_000_000,
      inputUrl: (body.input as { url: string }).url,
      jobId: body.jobId,
      leaseToken: "L".repeat(43),
      leaseUntil: body.leaseUntil,
      outputPrefix: "pod/tenant-a/render/artwork-a/1/attempt-1/",
      previewPutUrl: (body.output as { previewWebpPutUrl: string }).previewWebpPutUrl,
      printPutUrl: (body.output as { printPngPutUrl: string }).printPngPutUrl,
      profile: PROFILE,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown contract", { contract: 2 }],
    ["an unknown job type", { jobType: "studio.render_video" }],
    ["an http input", { input: { maxBytes: 10, url: "http://acct.r2.cloudflarestorage.com/b/k" } }],
    ["an input off the allowlist", { input: { maxBytes: 10, url: "https://example.test/k" } }],
    ["a zero maxBytes", { input: { maxBytes: 0, url: "https://acct.r2.cloudflarestorage.com/b/k" } }],
    ["a PUT off the allowlist", {
      output: { previewWebpPutUrl: "https://example.test/p", printPngPutUrl: "https://acct.r2.cloudflarestorage.com/b/p" },
    }],
    ["no profile", { profile: undefined }],
    ["a profile without min_dpi", { profile: { ...PROFILE, min_dpi: 0 } }],
    ["a profile with a garbage format list", { profile: { ...PROFILE, accepted_formats: ["png"] } }],
    ["a negative max_file_mb", { profile: { ...PROFILE, max_file_mb: -1 } }],
    ["an unparseable leaseUntil", { leaseUntil: "tomorrow" }],
    ["an output prefix without a trailing slash", { outputPrefix: "pod/t/render/a/1/attempt-1" }],
  ])("refuses %s but keeps the claim so the job can be failed now", (_label, overrides) => {
    const body = leaseBody(overrides);
    expect(parseLease(body)).toStrictEqual({
      claim: { attempt: 1, jobId: body.jobId, leaseToken: "L".repeat(43) },
      ok: false,
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["a job id that is not a UUID", { jobId: "../../admin" }],
    ["a fourth attempt", { attempt: 4 }],
    ["a short lease token", { leaseToken: "short" }],
  ])("has no claim at all for %s", (_label, overrides) => {
    expect(parseLease(leaseBody(overrides))).toStrictEqual({ claim: null, ok: false });
  });

  it("has no claim for a body that is not an object", () => {
    expect(parseLease(null)).toStrictEqual({ claim: null, ok: false });
    expect(parseLease([])).toStrictEqual({ claim: null, ok: false });
  });
});

describe("report bodies", () => {
  const parsed = parseLease(leaseBody());
  if (!parsed.ok) throw new Error("fixture");
  const lease: RenderLease = parsed.lease;

  it("a success names the attempt keys derived from the lease, never the PUT URLs", () => {
    const body = completionBody(
      lease,
      {
        meta: {
          effectiveDpi: 325,
          heightPx: 3200,
          maxPrintMm: { h: 250, w: 250 },
          pipelineVersion: 1,
          profileId: "front_a3",
          widthPx: 3200,
        },
        notices: [],
        ok: true,
        outputs: {
          previewWebp: { bytes: 2, sha256: "b".repeat(64) },
          printPng: { bytes: 1, sha256: "a".repeat(64) },
        },
      },
      { wallMs: 10 },
    );
    expect(Object.keys(body).sort()).toStrictEqual([
      "attempt", "fields", "leaseToken", "metrics", "notices", "ok", "outputs",
    ]);
    expect(body.outputs).toStrictEqual({
      previewWebp: { bytes: 2, key: `${lease.outputPrefix}preview.webp`, sha256: "b".repeat(64) },
      printPng: { bytes: 1, key: `${lease.outputPrefix}print.png`, sha256: "a".repeat(64) },
    });
  });

  it("a rejection carries only the reasons", () => {
    const body = completionBody(lease, { ok: false, reasons: [{ code: "x", message: "y" }] }, {});
    expect(body).toStrictEqual({
      attempt: 1,
      leaseToken: lease.leaseToken,
      metrics: {},
      ok: false,
      reasons: [{ code: "x", message: "y" }],
    });
  });

  it("a failure is a code", () => {
    expect(failureBody(lease, "input_fetch_failed")).toStrictEqual({
      attempt: 1,
      error: "input_fetch_failed",
      leaseToken: lease.leaseToken,
    });
  });

  it("metrics keep at most 20 finite numbers under keys the API accepts", () => {
    const many: Record<string, number> = { "bad key": 1, _lead: 2, nan: Number.NaN, inf: Infinity };
    for (let i = 0; i < 30; i += 1) many[`m${i}`] = i;
    const kept = sanitizeMetrics(many);
    expect(Object.keys(kept)).toHaveLength(20);
    expect(kept).not.toHaveProperty("bad key");
    expect(kept).not.toHaveProperty("_lead");
    expect(kept).not.toHaveProperty("nan");
    expect(kept).not.toHaveProperty("inf");
  });
});

describe("CP6-PS2: the canvas lease", () => {
  const base = "https://testaccount.eu.r2.cloudflarestorage.com/chopshop-test-private";
  function canvasBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      attempt: 1,
      contract: 1,
      input: { maxBytes: 5_000, sha256: "a".repeat(64), url: `${base}/pod/t/print/art.png?X-Amz-Signature=s` },
      jobId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      jobType: "pod.print_canvas",
      leaseToken: "A".repeat(43),
      leaseUntil: "2026-10-04T12:00:00.000Z",
      output: { canvasPngPutUrl: `${base}/pod/t/render/canvas/o/1/front/attempt-1/canvas.png?X-Amz-Signature=s` },
      outputPrefix: "pod/t/render/canvas/o/1/front/attempt-1/",
      spec: {
        background: "transparent",
        canvasPx: { h: 5_787, w: 4_606 },
        dpi: 300,
        motifPx: { h: 4_134, w: 2_953 },
        offsetPx: { left: 826, top: 826 },
        sourcePx: { h: 4_134, w: 2_953 },
        version: 1,
      },
      ...overrides,
    };
  }

  it("accepts the API's canvas acquire body and keeps exactly what a job needs", () => {
    const parsed = parseCanvasLease(canvasBody());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.lease).sort()).toEqual([
        "attempt", "canvasPutUrl", "inputMaxBytes", "inputSha256", "inputUrl", "jobId",
        "leaseToken", "leaseUntil", "outputPrefix", "spec",
      ]);
      expect(canvasOutputKey(parsed.lease.outputPrefix)).toBe("pod/t/render/canvas/o/1/front/attempt-1/canvas.png");
    }
    expect(leaseJobType(canvasBody())).toBe(CANVAS_JOB_TYPE);
    expect(leaseJobType({ jobType: undefined })).toBe(JOB_TYPE);
  });

  it("refuses a canvas envelope it cannot honestly execute, keeping the claim to report it", () => {
    const spec = canvasBody().spec as Record<string, unknown>;
    for (const overrides of [
      { jobType: "pod.process_artwork" },
      { contract: 2 },
      { input: { maxBytes: 5_000, sha256: "x", url: `${base}/a` } },
      { input: { maxBytes: 5_000, sha256: "a".repeat(64), url: "https://evil.test/a" } },
      { output: { canvasPngPutUrl: "http://169.254.169.254/" } },
      { spec: { ...spec, offsetPx: { left: 2_000, top: 826 } } },
      { spec: { ...spec, background: "white" } },
      { spec: { ...spec, canvasPx: { h: 9_000, w: 9_000 } } },
      { spec: { ...spec, offsetPx: { left: -1, top: 0 } } },
      { outputPrefix: "no-slash" },
    ]) {
      const parsed = parseCanvasLease(canvasBody(overrides));
      expect(parsed.ok, JSON.stringify(overrides)).toBe(false);
      expect(parsed.ok ? null : parsed.claim?.jobId).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
    }
    expect(parseCanvasLease({ jobType: "pod.print_canvas" })).toEqual({ claim: null, ok: false });
  });

  it("a canvas completion names the key derived from the lease; a refusal only its reasons", () => {
    const parsed = parseCanvasLease(canvasBody());
    if (!parsed.ok) throw new Error("fixture");
    expect(canvasCompletionBody(parsed.lease, { ok: true, output: { bytes: 9, sha256: "b".repeat(64) } }, { wallMs: 5 })).toEqual({
      attempt: 1,
      leaseToken: "A".repeat(43),
      metrics: { wallMs: 5 },
      ok: true,
      outputs: { canvasPng: { bytes: 9, key: "pod/t/render/canvas/o/1/front/attempt-1/canvas.png", sha256: "b".repeat(64) } },
    });
    expect(canvasCompletionBody(parsed.lease, { ok: false, reasons: [{ code: "dims_mismatch", message: "x" }] }, {})).toEqual({
      attempt: 1,
      leaseToken: "A".repeat(43),
      metrics: {},
      ok: false,
      reasons: [{ code: "dims_mismatch", message: "x" }],
    });
    expect(canvasReportPath("j", "complete")).toBe("/v1/render/canvas-jobs/j/complete");
    expect(ACQUIRE_BODY).toEqual({ jobTypes: ["pod.process_artwork", "pod.print_canvas"] });
    expect(CANVAS_MAX_INPUT_BYTES).toBe(536_870_912);
  });
});
