import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import worker from "../src/index";
import { DISPATCH_HOLD_UNTIL_MS } from "../src/commerce/dispatch-hold";
import { PRINTER_HOLD_UNTIL_MS } from "../src/dispatch/dispatch-effect";
import { FAKE_PRINTER_FETCH_OVERRIDE, SNAPWEAR_FETCH_OVERRIDE } from "../src/dispatch/printer-client";
import { processOutboxRowById } from "../src/outbox/effects";
import { runOutboxSweep } from "../src/outbox/sweeper";
import { sizeSlot } from "../src/pod/pod-mappings";
import {
  acquireCanvasJob,
  completeCanvasJob,
  failCanvasJob,
} from "../src/pod/print-canvas-jobs";
import { handleFakePrinterRoute } from "../src/routes/fake-printer";
import {
  alertsFor,
  grantAccess,
  grantMembership,
  lineRow,
  outboxRow,
  printerJobs,
  quietEnv,
  seedOrder,
  seedTenant,
  signUp,
  type SignedUpUser,
} from "./dispatch-fixtures";
import { adminRequest } from "./money-fixtures";
import {
  CANVAS_HOLD_UNTIL_MS,
  CANVAS_MAX_PIXELS,
  canvasFrame,
  canvasKey,
  canvasOutputPrefix,
  canvasReference,
  canvasSpec,
  type CanvasJobView,
  decidePrintFiles,
  type FrozenCanvasSlot,
  motifPlacement,
  printCanvasEnabled,
  SNAPWEAR_CANVAS_DPI,
  SNAPWEAR_CANVAS_TRANSPARENT,
  SNAPWEAR_MAX_CANVAS_BYTES,
} from "../src/dispatch/print-canvas";

/**
 * CP6-PS2 — the print canvas (docs/cf-port/CP6_PS2_REPORT.md). Part 1: the pure
 * geometry, one test per SnapWear assumption (named after its question), the
 * switch and the decision of which file a line sends.
 */

/** SnapWear's tee 64000: front 390×490 mm, offset 30 (PrintArea.xlsx). */
function teeFront(overrides: Partial<FrozenCanvasSlot> = {}): FrozenCanvasSlot {
  return {
    frameMm: { h: 490, offsetTopMm: 30, w: 390 },
    frameProvisional: false,
    location: "front",
    r2Key: "pod/t/print/art.png",
    sha256: "a".repeat(64),
    // sizeSlot(3543, 4724, 390×490, 300) = 299 × 399 mm.
    sourcePx: { h: 4_724, w: 3_543 },
    widthMm: 299,
    ...overrides,
  };
}

describe("the switch (read like PS1's)", () => {
  it("is on only for the exact string \"true\"", () => {
    expect(printCanvasEnabled({ PRINT_CANVAS_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "True", " true", "true ", "1", "yes"]) {
      expect(printCanvasEnabled({ PRINT_CANVAS_ENABLED: value }), String(value)).toBe(false);
    }
  });
});

describe("the canvas geometry", () => {
  it("is the frame at 300 DPI with the motif centred at its frozen width (the largest frame)", () => {
    const result = canvasSpec(teeFront());
    expect(result).toEqual({
      ok: true,
      spec: {
        background: "transparent",
        // 390 / 25.4 × 300 = 4606.3; 490 / 25.4 × 300 = 5787.4.
        canvasPx: { h: 5_787, w: 4_606 },
        dpi: 300,
        // 299 mm → 3531 px; × 4724 / 3543 = 4708.
        motifPx: { h: 4_708, w: 3_531 },
        offsetPx: { left: 537, top: 539 },
        sourcePx: { h: 4_724, w: 3_543 },
        version: 1,
      },
    });
  });

  it("OURS (motifPlacement): centred on both axes, the studio's placement, never top-aligned", () => {
    expect(motifPlacement({ h: 100, w: 100 }, { h: 20, w: 40 })).toEqual({ left: 30, top: 40 });
    // An odd remainder floors (left/top), deterministically.
    expect(motifPlacement({ h: 101, w: 101 }, { h: 20, w: 40 })).toEqual({ left: 30, top: 40 });
    // A wide logo in a tall frame sits in the middle, not at the top.
    const wide = canvasSpec(teeFront({ sourcePx: { h: 1_000, w: 5_000 }, widthMm: 390 }));
    expect(wide.ok && wide.spec.offsetPx).toEqual({ left: 0, top: 2_433 });
    expect(wide.ok && wide.spec.motifPx).toEqual({ h: 921, w: 4_606 });
  });

  it("C1 (canvasFrame): a line with no frozen frame fails closed (an order paid before PS2)", () => {
    const { frameMm: _frame, frameProvisional: _flag, ...old } = teeFront();
    expect(canvasFrame(old as FrozenCanvasSlot)).toEqual({ error: "print_canvas_frame_missing", ok: false });
    expect(canvasSpec(old)).toEqual({ error: "print_canvas_frame_missing", ok: false });
    // A frame without its stand-in flag is not trusted either.
    expect(canvasSpec(teeFront({ frameProvisional: undefined }))).toEqual({
      error: "print_canvas_frame_missing",
      ok: false,
    });
    expect(canvasSpec(teeFront({ frameMm: { h: 0, w: 390 } }))).toEqual({
      error: "print_canvas_frame_missing",
      ok: false,
    });
  });

  it("C1 (canvasFrame): a stand-in frame (64400, B445, SF500, TRUCKER, W101) fails closed, never printed at a guess", () => {
    expect(canvasFrame(teeFront({ frameProvisional: true }))).toEqual({
      error: "print_canvas_frame_provisional",
      ok: false,
    });
    expect(canvasSpec(teeFront({ frameProvisional: true }))).toEqual({
      error: "print_canvas_frame_provisional",
      ok: false,
    });
  });

  it("C2 (canvasReference): the canvas IS the frame; SnapWear's offsetTopMm is not drawn into it", () => {
    expect(canvasReference({ h: 490, offsetTopMm: 30, w: 390 })).toEqual({
      canvasMm: { h: 490, w: 390 },
      frameOriginMm: { x: 0, y: 0 },
    });
    const at30 = canvasSpec(teeFront());
    const at60 = canvasSpec(teeFront({ frameMm: { h: 490, offsetTopMm: 60, w: 390 } }));
    const none = canvasSpec(teeFront({ frameMm: { h: 490, w: 390 } }));
    expect(at60).toEqual(at30);
    expect(none).toEqual(at30);
  });

  it("C3 DPI (SNAPWEAR_CANVAS_DPI): 300; another answer only changes the pixel sizes", () => {
    expect(SNAPWEAR_CANVAS_DPI).toBe(300);
    const at150 = canvasSpec(teeFront(), { dpi: 150, transparent: true });
    expect(at150.ok && at150.spec).toMatchObject({
      canvasPx: { h: 2_894, w: 2_303 },
      dpi: 150,
      motifPx: { h: 2_355, w: 1_766 },
    });
  });

  it("C3 size (SNAPWEAR_MAX_CANVAS_BYTES): 100 MiB", () => {
    expect(SNAPWEAR_MAX_CANVAS_BYTES).toBe(104_857_600);
  });

  it("C3 alpha (SNAPWEAR_CANVAS_TRANSPARENT): accepted; if not, every line fails closed", () => {
    expect(SNAPWEAR_CANVAS_TRANSPARENT).toBe(true);
    expect(canvasSpec(teeFront(), { dpi: 300, transparent: false })).toEqual({
      error: "print_canvas_background_unsupported",
      ok: false,
    });
  });

  it("refuses a line without frozen artwork pixels", () => {
    expect(canvasSpec(teeFront({ sourcePx: undefined }))).toEqual({
      error: "print_canvas_source_missing",
      ok: false,
    });
    expect(canvasSpec(teeFront({ sourcePx: { h: 10, w: 0 } }))).toEqual({
      error: "print_canvas_source_missing",
      ok: false,
    });
  });

  it("a size checkout accepted is never refused for a pixel of rounding: the motif is clamped to the frame", () => {
    // sizeSlot (the size checkout froze) for artworks that fill the 250 × 350
    // frame's height: the width rounds to pixels, the height is rounded from
    // that width, and lands at 4135 px in a frame of 4134.
    const frame = { h: 350, w: 250 };
    for (const [w, h] of [[1_268, 8_871], [1_784, 5_781], [4_786, 7_283], [2_441, 9_819], [1_742, 7_526]] as const) {
      const size = sizeSlot(w, h, frame, 300);
      expect(size).not.toBeNull();
      const made = canvasSpec(teeFront({ frameMm: frame, sourcePx: { h, w }, widthMm: size?.widthMm ?? 0 }));
      expect(made.ok, `${w}×${h}`).toBe(true);
      if (made.ok) {
        expect(made.spec.canvasPx).toEqual({ h: 4_134, w: 2_953 });
        expect(made.spec.motifPx.h).toBe(4_134); // clamped from 4135
        expect(made.spec.offsetPx.top).toBe(0);
        expect(made.spec.offsetPx.left + made.spec.motifPx.w).toBeLessThanOrEqual(2_953);
      }
    }
    // The property, over many artworks and every frame size in use: whatever
    // sizeSlot accepts, canvasSpec makes, inside the canvas.
    let seed = 20261004;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (const box of [{ h: 350, w: 250 }, { h: 490, w: 390 }, { h: 180, w: 260 }, { h: 400, w: 300 }, { h: 100, w: 100 }]) {
      for (let i = 0; i < 4_000; i += 1) {
        const w = 1_000 + Math.floor(next() * 9_000);
        const h = 1_000 + Math.floor(next() * 9_000);
        const size = sizeSlot(w, h, box, 300);
        if (size === null) continue;
        const made = canvasSpec(teeFront({ frameMm: box, sourcePx: { h, w }, widthMm: size.widthMm }));
        expect(made.ok, `${box.w}×${box.h} with ${w}×${h}`).toBe(true);
        if (made.ok) {
          expect(made.spec.offsetPx.left + made.spec.motifPx.w).toBeLessThanOrEqual(made.spec.canvasPx.w);
          expect(made.spec.offsetPx.top + made.spec.motifPx.h).toBeLessThanOrEqual(made.spec.canvasPx.h);
        }
      }
    }
  });

  it("refuses a motif that would exceed the frame, never cropping or shrinking it", () => {
    // Wider than the frame.
    expect(canvasSpec(teeFront({ widthMm: 391 }))).toEqual({
      error: "print_canvas_motif_exceeds_frame",
      ok: false,
    });
    // Taller than the frame at its width (a corrupt pixel size).
    expect(canvasSpec(teeFront({ sourcePx: { h: 9_000, w: 3_543 } }))).toEqual({
      error: "print_canvas_motif_exceeds_frame",
      ok: false,
    });
    // One millimetre too tall is refused; the fit is judged in millimetres.
    expect(canvasSpec(teeFront({ frameMm: { h: 350, w: 250 }, sourcePx: { h: 3_511, w: 2_500 }, widthMm: 250 }))).toEqual({
      error: "print_canvas_motif_exceeds_frame",
      ok: false,
    });
    // Exactly the frame fits (390 × 490 mm at 390 × 490 px aspect).
    const full = canvasSpec(teeFront({ sourcePx: { h: 4_900, w: 3_900 }, widthMm: 390 }));
    expect(full.ok && full.spec).toMatchObject({ motifPx: { h: 5_787, w: 4_606 }, offsetPx: { left: 0, top: 0 } });
  });

  it("refuses a canvas larger than the container is asked to make", () => {
    expect(CANVAS_MAX_PIXELS).toBe(40_000_000);
    expect(canvasSpec(teeFront({ frameMm: { h: 700, w: 600 }, widthMm: 299 }))).toEqual({
      error: "print_canvas_too_large",
      ok: false,
    });
  });

  it("names the canonical key under the order in the shop's print path, and the attempt prefix", () => {
    expect(canvasKey("shop-a", "ord-1", 2, "back")).toBe("pod/shop-a/print/orders/ord-1/2-back.png");
    expect(canvasOutputPrefix("shop-a", "ord-1", 2, "back")).toBe("pod/shop-a/render/canvas/ord-1/2/back/");
  });

  it("parks at its own hold instant, distinct from the payment and printer holds", () => {
    expect(new Set([CANVAS_HOLD_UNTIL_MS, PRINTER_HOLD_UNTIL_MS, DISPATCH_HOLD_UNTIL_MS]).size).toBe(3);
    expect(CANVAS_HOLD_UNTIL_MS).toBe(DISPATCH_HOLD_UNTIL_MS - 2_000);
  });
});

describe("decidePrintFiles: which file a line sends", () => {
  const done = (slot: "back" | "front"): CanvasJobView => ({
    canvasKey: `pod/t/print/orders/o/1-${slot}.png`,
    canvasSha256: (slot === "front" ? "f" : "b").repeat(64),
    error: null,
    slot,
    state: "completed",
  });
  const queued = (slot: "back" | "front"): CanvasJobView => ({ ...done(slot), canvasSha256: null, state: "queued" });
  const failed = (slot: "back" | "front"): CanvasJobView => ({
    ...done(slot),
    canvasSha256: null,
    error: "pipeline_crashed",
    state: "failed",
  });
  const slots = ["front", "back"] as const;

  it("a complete set of canvases is sent whatever the switch or the row (a re-dispatch gets the same file)", () => {
    for (const switchOn of [true, false]) {
      for (const submitted of [true, false]) {
        expect(decidePrintFiles({ canvases: [done("back"), done("front")], slots, submitted, switchOn })).toEqual({
          files: [
            { location: "front", r2Key: "pod/t/print/orders/o/1-front.png", sha256: "f".repeat(64) },
            { location: "back", r2Key: "pod/t/print/orders/o/1-back.png", sha256: "b".repeat(64) },
          ],
          kind: "canvas",
        });
      }
    }
  });

  it("a row already submitted without a complete set keeps the artwork files", () => {
    expect(decidePrintFiles({ canvases: [], slots, submitted: true, switchOn: true })).toEqual({ kind: "artwork" });
    expect(decidePrintFiles({ canvases: [failed("front")], slots, submitted: true, switchOn: true })).toEqual({
      kind: "artwork",
    });
  });

  it("switch off: the artwork files, even with canvases half made", () => {
    expect(decidePrintFiles({ canvases: [], slots, submitted: false, switchOn: false })).toEqual({ kind: "artwork" });
    expect(decidePrintFiles({ canvases: [done("front"), queued("back")], slots, submitted: false, switchOn: false })).toEqual({
      kind: "artwork",
    });
  });

  it("switch on: a failed canvas is terminal; anything else is ensured and waited for", () => {
    expect(decidePrintFiles({ canvases: [done("front"), failed("back")], slots, submitted: false, switchOn: true })).toEqual({
      error: "print_canvas_failed",
      kind: "terminal",
    });
    expect(decidePrintFiles({ canvases: [], slots, submitted: false, switchOn: true })).toEqual({ kind: "ensure" });
    expect(decidePrintFiles({ canvases: [done("front"), queued("back")], slots, submitted: false, switchOn: true })).toEqual({
      kind: "ensure",
    });
    // A canvas of a slot the line does not print is not counted.
    expect(decidePrintFiles({ canvases: [done("back")], slots: ["front"], submitted: false, switchOn: true })).toEqual({
      kind: "ensure",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Part 2: the dispatcher end to end (park → render → release → submit).
// ═══════════════════════════════════════════════════════════════════════════

const TENANT = "tenant-print-canvas";
const ON = { PRINT_CANVAS_ENABLED: "true" };
/** A tee front 390×490 mm; the fixture's motif is 250 × 350 mm (2953 × 4134 px). */
const CANVAS = {
  frameMm: { h: 490, offsetTopMm: 30, w: 390 },
  frameProvisional: false,
  sourcePx: { h: 4_134, w: 2_953 },
};
const MINUTE = 60_000;

let seller: SignedUpUser;

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function seedCanvasOrder(
  slots: Array<"back" | "front"> = ["front"],
  canvas: Record<string, unknown> | "none" = CANVAS,
) {
  return seedOrder(TENANT, {
    lines: [{ printFiles: slots.map((slot) => (canvas === "none" ? { slot } : { canvas, slot })) }],
  });
}

function dispatch(targetEnv: Env, outboxId: string, clock?: () => number) {
  return processOutboxRowById(targetEnv, outboxId, clock);
}

/** The container's part: every queued canvas rendered (bytes stand in for pixels). */
async function renderAll(targetEnv: Env = quietEnv().env): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const lease = await acquireCanvasJob(targetEnv, env.DB, Date.now());
    if (lease === null) {
      return done;
    }
    const bytes = new TextEncoder().encode(`canvas png of ${lease.jobId}`);
    const key = `${lease.outputPrefix}canvas.png`;
    await env.PRIVATE_BUCKET.put(key, bytes);
    const result = await completeCanvasJob(targetEnv, env.DB, lease.jobId, {
      attempt: lease.attempt,
      leaseToken: lease.leaseToken,
      ok: true,
      outputs: { canvasPng: { bytes: bytes.length, key, sha256: await sha256Hex(bytes) } },
    }, Date.now());
    expect(result).toEqual({ status: "completed" });
    done.push(lease.jobId);
  }
  return done;
}

async function canvasRows(orderId: string) {
  const rows = await env.DB.prepare(
    `SELECT id, line_no, slot, state, error, canvas_key, canvas_sha256, spec_json
     FROM print_canvas_jobs WHERE order_id = ? ORDER BY line_no, slot`,
  )
    .bind(orderId)
    .all<{
      canvas_key: string;
      canvas_sha256: string | null;
      error: string | null;
      id: string;
      line_no: number;
      slot: string;
      spec_json: string;
      state: string;
    }>();
  return rows.results;
}

/** The object keys the printer was given, decoded from the presigned URLs. */
function sentKeys(body: { artworks: Array<{ url: string }> }): string[] {
  return body.artworks.map((artwork) => decodeURIComponent(new URL(artwork.url).pathname));
}

async function printedKeys(orderId: string): Promise<string[][]> {
  return (await printerJobs(orderId)).map((job) =>
    sentKeys(JSON.parse(job.payload_json) as { artworks: Array<{ url: string }> }),
  );
}

/** A fake-printer transport that records each body, optionally losing the answer. */
function recordingPrinter(options: { lose?: boolean } = {}) {
  const bodies: Array<{ artworks: Array<{ url: string }>; job_id: string }> = [];
  const fetcher = async (request: Request): Promise<Response> => {
    bodies.push(await request.clone().json());
    const response = await handleFakePrinterRoute(env as unknown as Env, request);
    if (options.lose === true) {
      throw new Error("connection reset");
    }
    return response;
  };
  return { bodies, fetcher };
}

beforeAll(async () => {
  await seedTenant(TENANT);
  seller = await signUp("seller@print-canvas.test");
  await grantAccess(seller.userId, "tenant_admin");
  await grantMembership(seller.userId, TENANT);
});

beforeEach(async () => {
  // Sweeps claim the oldest due row of ANY order; start each test clean.
  await env.DB.prepare("DELETE FROM outbox_events").run();
});

// The canvas acquire takes the oldest job of ANY test: settle what a test left.
afterEach(async () => {
  for (let i = 0; i < 30; i += 1) {
    const lease = await acquireCanvasJob(quietEnv().env, env.DB, Date.now());
    if (lease === null) {
      return;
    }
    await failCanvasJob(quietEnv().env, env.DB, lease.jobId, {
      attempt: lease.attempt,
      error: "test_cleanup",
      leaseToken: lease.leaseToken,
    }, Date.now());
  }
});

describe("dispatch with the print canvas", () => {
  it("switch off (every value but \"true\"): the artwork file, no canvas job, exactly as before", async () => {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      const order = await seedCanvasOrder();
      const result = await dispatch(quietEnv({ PRINT_CANVAS_ENABLED: value }).env, order.dispatchIds[0] as string);
      expect(result, String(value)).toEqual({ kind: "ran", outcome: { kind: "done" } });
      expect(await canvasRows(order.orderId)).toEqual([]);
      const [keys] = await printedKeys(order.orderId);
      expect(keys?.[0]).toMatch(new RegExp(`/pod/${TENANT}/print/art-\\d+-1-front\\.png$`));
    }
  });

  it("switch on: parks the row (no attempt spent), renders, is released, and sends the canvas", async () => {
    const order = await seedCanvasOrder();
    const dispatchId = order.dispatchIds[0] as string;
    const quiet = quietEnv(ON);

    const first = await dispatch(quiet.env, dispatchId);
    expect(first).toMatchObject({ kind: "ran", outcome: { kind: "retry" } });
    expect(await outboxRow(dispatchId)).toMatchObject({
      attempts: 1,
      claimed_by: null,
      last_error: "print_canvas_pending",
      next_attempt_at: CANVAS_HOLD_UNTIL_MS,
      status: "pending",
    });
    // The line is untouched while it waits (the seller reads "queued").
    expect((await lineRow(order.orderId)).dispatch_state).toBeNull();
    const [row] = await canvasRows(order.orderId);
    expect(row).toMatchObject({
      canvas_key: `pod/${TENANT}/print/orders/${order.orderId}/1-front.png`,
      line_no: 1,
      slot: "front",
      state: "queued",
    });
    expect(JSON.parse(row?.spec_json ?? "{}")).toEqual({
      background: "transparent",
      canvasPx: { h: 5_787, w: 4_606 },
      dpi: 300,
      // 250 mm → 2953 px; × 4134 / 2953 = 4134.
      motifPx: { h: 4_134, w: 2_953 },
      offsetPx: { left: 826, top: 826 },
      sourcePx: { h: 4_134, w: 2_953 },
      version: 1,
    });
    expect(quiet.renders.sent).toEqual([{ renderJobId: row?.id }]);
    expect(await printerJobs(order.orderId)).toEqual([]);
    // A sweep while it renders sends nothing and spends nothing.
    await runOutboxSweep(quietEnv(ON).env, Date.now() + 20 * MINUTE);
    expect((await outboxRow(dispatchId)).attempts).toBe(1);

    const releaseQuiet = quietEnv(ON);
    await renderAll(releaseQuiet.env);
    expect(releaseQuiet.nudges.sent).toEqual([{ outboxId: dispatchId }]);
    expect((await outboxRow(dispatchId)).next_attempt_at).toBeLessThanOrEqual(Date.now());

    const second = await dispatch(quietEnv(ON).env, dispatchId);
    expect(second).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(await outboxRow(dispatchId)).toMatchObject({ attempts: 2, status: "done" });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("accepted");
    const [keys] = await printedKeys(order.orderId);
    expect(keys).toHaveLength(1);
    expect(keys?.[0]?.endsWith(`/pod/${TENANT}/print/orders/${order.orderId}/1-front.png`)).toBe(true);
    // The job body says nothing about placement: layouts carry only the location.
    const body = JSON.parse((await printerJobs(order.orderId))[0]?.payload_json ?? "{}") as Record<string, unknown>;
    expect(body.layouts).toEqual([{ location: "front" }]);
    expect(Object.keys(body).sort()).toEqual(["artworks", "items", "job_id", "layouts", "mockups"]);
  });

  it("front + back: one canvas per slot, the row released only when both are made, front before back", async () => {
    const order = await seedCanvasOrder(["front", "back"]);
    const dispatchId = order.dispatchIds[0] as string;
    await dispatch(quietEnv(ON).env, dispatchId);
    expect((await canvasRows(order.orderId)).map((row) => [row.slot, row.state])).toEqual([
      ["back", "queued"],
      ["front", "queued"],
    ]);
    // One canvas made: still parked.
    const lease = await acquireCanvasJob(quietEnv().env, env.DB, Date.now());
    const bytes = new TextEncoder().encode("one side");
    await env.PRIVATE_BUCKET.put(`${lease?.outputPrefix}canvas.png`, bytes);
    await completeCanvasJob(quietEnv().env, env.DB, lease?.jobId ?? "", {
      attempt: 1,
      leaseToken: lease?.leaseToken,
      ok: true,
      outputs: { canvasPng: { bytes: bytes.length, key: `${lease?.outputPrefix}canvas.png`, sha256: await sha256Hex(bytes) } },
    }, Date.now());
    expect((await outboxRow(dispatchId)).next_attempt_at).toBe(CANVAS_HOLD_UNTIL_MS);
    await renderAll();
    expect(await dispatch(quietEnv(ON).env, dispatchId)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    const [keys] = await printedKeys(order.orderId);
    expect(keys?.map((key) => key.split("/").pop())).toEqual(["1-front.png", "1-back.png"]);
  });

  it("a re-dispatch after a lost answer sends the SAME canvas (same key, same recorded sha256)", async () => {
    const order = await seedCanvasOrder();
    const dispatchId = order.dispatchIds[0] as string;
    await dispatch(quietEnv(ON).env, dispatchId);
    await renderAll();
    const before = await canvasRows(order.orderId);

    const losing = recordingPrinter({ lose: true });
    await dispatch(quietEnv({ ...ON, [FAKE_PRINTER_FETCH_OVERRIDE]: losing.fetcher }).env, dispatchId);
    expect((await outboxRow(dispatchId)).status).toBe("unknown");

    const answering = recordingPrinter();
    const again = await dispatch(
      quietEnv({ ...ON, [FAKE_PRINTER_FETCH_OVERRIDE]: answering.fetcher }).env,
      dispatchId,
      () => Date.now() + 3 * 60 * MINUTE,
    );
    expect(again).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(answering.bodies[0]?.job_id).toBe(losing.bodies[0]?.job_id);
    expect(sentKeys(answering.bodies[0]!)).toEqual(sentKeys(losing.bodies[0]!));
    expect(sentKeys(answering.bodies[0]!)[0]?.endsWith(`/print/orders/${order.orderId}/1-front.png`)).toBe(true);
    expect(await canvasRows(order.orderId)).toEqual(before);
  });

  it("a job first sent WITHOUT a canvas keeps its artwork file after the switch is turned on", async () => {
    const order = await seedCanvasOrder();
    const dispatchId = order.dispatchIds[0] as string;
    const losing = recordingPrinter({ lose: true });
    await dispatch(quietEnv({ [FAKE_PRINTER_FETCH_OVERRIDE]: losing.fetcher }).env, dispatchId);
    expect((await outboxRow(dispatchId)).status).toBe("unknown");

    const answering = recordingPrinter();
    const again = await dispatch(
      quietEnv({ ...ON, [FAKE_PRINTER_FETCH_OVERRIDE]: answering.fetcher }).env,
      dispatchId,
      () => Date.now() + 3 * 60 * MINUTE,
    );
    expect(again).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect(sentKeys(answering.bodies[0]!)).toEqual(sentKeys(losing.bodies[0]!));
    expect(sentKeys(answering.bodies[0]!)[0]).toMatch(/\/print\/art-\d+-1-front\.png$/);
    expect(await canvasRows(order.orderId)).toEqual([]);
  });

  it("a canvas that fails for good fails the dispatch with its alert; the printer receives nothing", async () => {
    const order = await seedCanvasOrder();
    const dispatchId = order.dispatchIds[0] as string;
    await dispatch(quietEnv(ON).env, dispatchId);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const lease = await acquireCanvasJob(quietEnv().env, env.DB, Date.now());
      await failCanvasJob(quietEnv().env, env.DB, lease?.jobId ?? "", {
        attempt,
        error: "pipeline_crashed",
        leaseToken: lease?.leaseToken,
      }, Date.now());
    }
    expect((await outboxRow(dispatchId)).next_attempt_at).toBeLessThanOrEqual(Date.now());
    const result = await dispatch(quietEnv(ON).env, dispatchId);
    expect(result).toMatchObject({ kind: "ran", outcome: { kind: "failed" } });
    expect(await outboxRow(dispatchId)).toMatchObject({ last_error: "print_canvas_failed", status: "failed" });
    expect((await lineRow(order.orderId)).dispatch_state).toBe("failed");
    expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).toEqual(["dispatch_failed"]);
    expect(await printerJobs(order.orderId)).toEqual([]);
  });

  const failClosed: Array<[string, Record<string, unknown> | "none", string]> = [
    ["a line frozen before CP6-PS2 (no frame)", "none", "print_canvas_frame_missing"],
    ["a stand-in frame", { ...CANVAS, frameProvisional: true }, "print_canvas_frame_provisional"],
    ["no frozen artwork pixels", { frameMm: CANVAS.frameMm, frameProvisional: false }, "print_canvas_source_missing"],
    ["a motif wider than the frame", { ...CANVAS, frameMm: { h: 490, w: 240 } }, "print_canvas_motif_exceeds_frame"],
  ];
  for (const [name, canvas, error] of failClosed) {
    it(`fails closed on ${name}: terminal ${error}, its alert, no canvas job, no printer call`, async () => {
      const order = await seedCanvasOrder(["front"], canvas);
      const dispatchId = order.dispatchIds[0] as string;
      const quiet = quietEnv(ON);
      const result = await dispatch(quiet.env, dispatchId);
      expect(result).toMatchObject({ kind: "ran", outcome: { kind: "failed" } });
      expect(await outboxRow(dispatchId)).toMatchObject({ last_error: error, status: "failed" });
      expect((await alertsFor(dispatchId)).map((alert) => alert.kind)).toEqual(["dispatch_failed"]);
      expect(await canvasRows(order.orderId)).toEqual([]);
      expect(quiet.renders.sent).toEqual([]);
      expect(await printerJobs(order.orderId)).toEqual([]);
    });
  }

  it("a completed canvas made from another file than the frozen master is never sent (print_canvas_input_mismatch)", async () => {
    const order = await seedCanvasOrder();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO print_canvas_jobs (id, tenant_id, order_id, line_no, slot, attempt, state,
         input_key, input_sha256, input_bytes, spec_json, output_prefix, canvas_key,
         canvas_sha256, canvas_bytes, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, 1, 'front', 1, 'completed', ?, ?, 10, '{}', ?, ?, ?, 10, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        TENANT,
        order.orderId,
        `pod/${TENANT}/print/someone-else.png`,
        "e".repeat(64),
        `pod/${TENANT}/render/canvas/${order.orderId}/1/front/`,
        `pod/${TENANT}/print/orders/${order.orderId}/1-front.png`,
        "f".repeat(64),
        now,
        now,
        now,
      )
      .run();
    const result = await dispatch(quietEnv(ON).env, order.dispatchIds[0] as string);
    expect(result).toMatchObject({ kind: "ran", outcome: { kind: "failed" } });
    expect((await outboxRow(order.dispatchIds[0] as string)).last_error).toBe("print_canvas_input_mismatch");
    expect(await printerJobs(order.orderId)).toEqual([]);
  });

  it("a missing print master is terminal before any canvas is queued (print_file_missing)", async () => {
    const order = await seedOrder(TENANT, { lines: [{ printFiles: [{ canvas: CANVAS, present: false, slot: "front" }] }] });
    const result = await dispatch(quietEnv(ON).env, order.dispatchIds[0] as string);
    expect(result).toMatchObject({ kind: "ran", outcome: { kind: "failed" } });
    expect((await outboxRow(order.dispatchIds[0] as string)).last_error).toBe("print_file_missing");
    expect(await canvasRows(order.orderId)).toEqual([]);
  });

  it("canvases made between the read and the park: the row is not parked, the same run sends them", async () => {
    const order = await seedCanvasOrder();
    const dispatchId = order.dispatchIds[0] as string;
    await dispatch(quietEnv(ON).env, dispatchId);
    // Something made the row due while its canvas is still queued.
    await env.DB.prepare("UPDATE outbox_events SET next_attempt_at = ? WHERE outbox_id = ?")
      .bind(Date.now(), dispatchId)
      .run();
    // The container finishes exactly when the dispatcher's park batch is sent.
    let raced = false;
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced && statements.length >= 3) {
              raced = true;
              await renderAll();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const result = await dispatch(quietEnv({ ...ON, DB: db }).env, dispatchId);
    expect(raced).toBe(true);
    expect(result).toEqual({ kind: "ran", outcome: { kind: "done" } });
    const [keys] = await printedKeys(order.orderId);
    expect(keys?.[0]?.endsWith(`/print/orders/${order.orderId}/1-front.png`)).toBe(true);
  });

  it("staging with every SnapWear value set and the canvas on never calls SnapWear", async () => {
    const snapwearCalls: string[] = [];
    const snapwear = async (request: Request): Promise<Response> => {
      snapwearCalls.push(request.url);
      return Response.json({ id: "SW-1", status: "accepted" }, { status: 201 });
    };
    const staging = (target: string) =>
      quietEnv({
        ...ON,
        APP_ENV: "staging",
        DISPATCH_TARGET: target,
        SNAPWEAR_API_BASE_URL: "https://api.snapwear.test.invalid",
        SNAPWEAR_API_TOKEN: "test-only-snapwear-api-token-0123456789",
        SNAPWEAR_SUBMIT_ENABLED: "true",
        [SNAPWEAR_FETCH_OVERRIDE]: snapwear,
      }).env;

    // Pointed at the fake: the canvas goes to the fake, never to SnapWear.
    const order = await seedCanvasOrder();
    const dispatchId = order.dispatchIds[0] as string;
    await dispatch(staging("fake-printer"), dispatchId);
    await renderAll();
    expect(await dispatch(staging("fake-printer"), dispatchId)).toEqual({ kind: "ran", outcome: { kind: "done" } });
    expect((await printedKeys(order.orderId))[0]?.[0]?.endsWith("/1-front.png")).toBe(true);

    // Pointed at SnapWear: no client, the row is held for the printer before any canvas.
    const held = await seedOrder(TENANT, {
      lines: [{ printFiles: [{ canvas: CANVAS, slot: "front" }] }],
      printer: "snapwear",
    });
    await dispatch(staging("snapwear"), held.dispatchIds[0] as string);
    expect((await outboxRow(held.dispatchIds[0] as string)).next_attempt_at).toBe(PRINTER_HOLD_UNTIL_MS);
    expect(await canvasRows(held.orderId)).toEqual([]);
    expect(snapwearCalls).toEqual([]);
  });
});

describe("the sweeper and the canvas", () => {
  it("backstop: a row still parked with nothing pending is released and sent by the next sweep", async () => {
    const order = await seedCanvasOrder();
    const dispatchId = order.dispatchIds[0] as string;
    await dispatch(quietEnv(ON).env, dispatchId);
    await renderAll();
    // As if the release in the settling batch had not happened.
    await env.DB.prepare("UPDATE outbox_events SET next_attempt_at = ? WHERE outbox_id = ?")
      .bind(CANVAS_HOLD_UNTIL_MS, dispatchId)
      .run();
    const summary = await runOutboxSweep(quietEnv(ON).env, Date.now());
    expect(summary.canvasReleased).toBe(1);
    expect((await outboxRow(dispatchId)).status).toBe("done");
  });

  it("re-nudges the container for a canvas job waiting more than five minutes", async () => {
    const order = await seedCanvasOrder();
    await dispatch(quietEnv(ON).env, order.dispatchIds[0] as string);
    const [row] = await canvasRows(order.orderId);
    const quiet = quietEnv(ON);
    expect((await runOutboxSweep(quiet.env, Date.now())).renderNudged).toBe(false);
    const summary = await runOutboxSweep(quiet.env, Date.now() + 10 * MINUTE);
    expect(summary.renderNudged).toBe(true);
    expect(quiet.renders.sent).toContainEqual({ renderJobId: row?.id });
  });
});

describe("one number: the seller's order pages do not change shape", () => {
  function keyPaths(value: unknown, path = "$"): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((item) => keyPaths(item, `${path}[]`));
    }
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).flatMap(([key, item]) => [`${path}.${key}`, ...keyPaths(item, `${path}.${key}`)]);
    }
    return [];
  }

  async function sellerGet(path: string): Promise<string> {
    const response = await worker.fetch(
      adminRequest(path, "GET", { cookie: seller.cookie, origin: null, shopId: TENANT }),
      quietEnv().env,
    );
    expect(response.status).toBe(200);
    return response.text();
  }

  it("a canvas-dispatched order reads exactly like an artwork-dispatched one, with no canvas fact in it", async () => {
    const withCanvas = await seedCanvasOrder();
    await dispatch(quietEnv(ON).env, withCanvas.dispatchIds[0] as string);
    await renderAll();
    await dispatch(quietEnv(ON).env, withCanvas.dispatchIds[0] as string);
    const plain = await seedOrder(TENANT);
    await dispatch(quietEnv().env, plain.dispatchIds[0] as string);
    expect((await lineRow(withCanvas.orderId)).dispatch_state).toBe("accepted");
    expect((await lineRow(plain.orderId)).dispatch_state).toBe("accepted");

    const detailCanvas = await sellerGet(`/v1/admin/orders/${withCanvas.orderId}`);
    const detailPlain = await sellerGet(`/v1/admin/orders/${plain.orderId}`);
    expect(new Set(keyPaths(JSON.parse(detailCanvas)))).toEqual(new Set(keyPaths(JSON.parse(detailPlain))));

    const list = JSON.parse(await sellerGet("/v1/admin/orders")) as { orders: Array<Record<string, unknown>> };
    const rowOf = (orderId: string) => list.orders.find((row) => JSON.stringify(row).includes(orderId));
    expect(rowOf(withCanvas.orderId)).toBeDefined();
    expect(new Set(keyPaths(rowOf(withCanvas.orderId)))).toEqual(new Set(keyPaths(rowOf(plain.orderId))));

    for (const text of [detailCanvas, JSON.stringify(list)]) {
      for (const leak of ["print/orders", "canvas", "frameMm", "frameProvisional", "sourcePx", "pod/", "spec"]) {
        expect(text).not.toContain(leak);
      }
    }
  });
});
