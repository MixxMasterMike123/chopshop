/**
 * The pull loop and the job runner.
 *
 * ── THE LOOP ────────────────────────────────────────────────────────────────
 * While ARMED it POSTs acquire: immediately after a job (there may be more), every
 * POLL_INTERVAL_MS after a 204, and after the API's own back-off when acquire
 * cannot be answered. With IDLE_EXIT_SECONDS of no work (no lease acquired, no job
 * running) it DISARMS and stops polling; the Durable Object's `sleepAfter` then
 * stops the instance. `wake()` (POST /wake, sent by the Durable Object on every
 * queue nudge) re-arms it. One poller for any MAX_CONCURRENT_JOBS: it only asks
 * for a lease while a slot is free, so idle polling costs one request per interval
 * however many slots there are.
 *
 * ── A JOB ───────────────────────────────────────────────────────────────────
 *   input GET → file (streamed, capped) → pipeline → both PUTs (streamed, hashed)
 *   → complete; a gate REJECTION is a completion too (`ok: false`, the Swedish
 *   reasons). Anything that is not a verdict → fail with a code: the API requeues
 *   the job (attempts 1–2) or ends it with an alert (attempt 3). The lease fence
 *   lives in the API; this side never decides whether its lease still holds — it
 *   reports, and a 409 means someone else owns the job now.
 *
 * ── THE LEASE HOLD ──────────────────────────────────────────────────────────
 * A job can be leased to this container without it holding the job: an acquire
 * whose answer was lost (or unreadable, or a 5xx after the lease committed), a
 * complete/fail report abandoned when the lease ran short, an envelope too broken
 * to report against, a runner that crashed. Every later acquire then answers 204
 * until that lease expires, and the nudge that woke the container was already
 * acked — so disarming on the idle clock would strand the artwork in
 * `processing` until some other upload woke the container. Each such event
 * records the lease's end (known, or assumed: acquire time + API_LEASE_MS), and
 * the loop does NOT disarm before that end + LEASE_HOLD_MARGIN_MS: it keeps
 * polling, and the first acquire after expiry re-leases the job as attempt+1 (or
 * ends it after attempt 3). /healthz reports the hold (`leaseHoldMs`) so the
 * Durable Object keeps the instance alive through it. This covers a container
 * that stays up; the durable backstop, for one that does not, is the CP2
 * 15-minute sweeper re-nudging expired-lease jobs (PLAN §2.2).
 *
 * ── A CANVAS JOB (CP6-PS2, `pod.print_canvas`) ───────────────────────────────
 *   input GET (the line's print master) → file → render/src/canvas.ts (verify the
 *   sha256 and the pixels, place the motif on the transparent frame) → one PUT
 *   (streamed, hashed) → complete on /v1/render/canvas-jobs/{id}/complete. A
 *   mismatch is a completion with `ok: false` (the API ends the job: retrying
 *   cannot fix it); a transfer or render failure is a fail code, as above.
 *
 * Logs are JSON lines: job id, attempt, codes, sizes, timings. Never the token,
 * never a URL, never a response body.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type AcquireResult, isUnsettled, type RenderApi, type ReportStatus } from "./api.ts";
import { renderCanvas } from "./canvas.ts";
import {
  API_LEASE_MS,
  CANVAS_JOB_TYPE,
  CANVAS_MAX_INPUT_BYTES,
  canvasCompletionBody,
  completionBody,
  failureBody,
  type FailureCode,
  HARD_MAX_INPUT_BYTES,
  type LeaseClaim,
  leaseJobType,
  parseCanvasLease,
  parseLease,
  type RenderLease,
} from "./contract.ts";
import type { Logger } from "./log.ts";
import { memorySnapshotMb, resetPeakRss } from "./metrics.ts";
import { runArtworkPipeline, type PipelineResult } from "./pipeline.ts";
import { downloadToFile, type FetchLike, putFile, TransferError } from "./transfer.ts";

export const POLL_INTERVAL_MS = 3_000;

/**
 * Past a lease's end before the hold lets the loop disarm: covers the clock skew
 * between this container and the API (the lease end is the API's clock) and leaves
 * room for many polls after the expiry, the first of which re-leases the job.
 */
export const LEASE_HOLD_MARGIN_MS = 60_000;

/**
 * Report retries stop this long before the lease ends: a report arriving after
 * the end is refused (409) whatever it says, and the margin absorbs clock skew.
 */
export const REPORT_DEADLINE_MARGIN_MS = 10_000;

export interface RenderWorkerOptions {
  api: Pick<RenderApi, "acquire" | "report">;
  /** The lease length to assume when a lease's end is unknown (default API_LEASE_MS). */
  assumedLeaseMs?: number;
  /** For the two R2 transfers (the API calls go through `api`). */
  fetch: FetchLike;
  idleExitMs: number;
  /** Default LEASE_HOLD_MARGIN_MS. */
  leaseHoldMarginMs?: number;
  log: Logger;
  maxConcurrentJobs: number;
  now?: () => number;
  pollIntervalMs?: number;
  /** Default REPORT_DEADLINE_MARGIN_MS. */
  reportMarginMs?: number;
  /** Swappable for tests; the canvas renderer is the real one by default. */
  runCanvas?: typeof renderCanvas;
  /** Swappable for tests; the pipeline is the real one by default. */
  runPipeline?: typeof runArtworkPipeline;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkerStatus {
  inFlight: number;
  jobsCompleted: number;
  jobsFailed: number;
  /** > 0 while a job may still be leased to this container (see THE LEASE HOLD). */
  leaseHoldMs: number;
  polling: boolean;
  stopping: boolean;
  uptimeMs: number;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RenderWorker {
  readonly #api: Pick<RenderApi, "acquire" | "report">;
  readonly #assumedLeaseMs: number;
  readonly #fetch: FetchLike;
  readonly #idleExitMs: number;
  readonly #leaseHoldMarginMs: number;
  readonly #log: Logger;
  readonly #maxConcurrentJobs: number;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #reportMarginMs: number;
  readonly #runCanvas: typeof renderCanvas;
  readonly #runPipeline: typeof runArtworkPipeline;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #startedAt: number;

  #armed = false;
  #firstAcquireLogged = false;
  #inFlight = new Set<Promise<void>>();
  #jobsCompleted = 0;
  #jobsFailed = 0;
  #lastActivityAt: number;
  // Container clock; the loop does not disarm before it (THE LEASE HOLD).
  #leaseHoldUntil = 0;
  #loop: Promise<void> | null = null;
  #stopping = false;
  // Resolved to wake a loop parked on "disarmed" or "no free slot".
  #nudge: (() => void) | null = null;

  constructor(options: RenderWorkerOptions) {
    this.#api = options.api;
    this.#assumedLeaseMs = options.assumedLeaseMs ?? API_LEASE_MS;
    this.#fetch = options.fetch;
    this.#idleExitMs = options.idleExitMs;
    this.#leaseHoldMarginMs = options.leaseHoldMarginMs ?? LEASE_HOLD_MARGIN_MS;
    this.#log = options.log;
    this.#maxConcurrentJobs = options.maxConcurrentJobs;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#reportMarginMs = options.reportMarginMs ?? REPORT_DEADLINE_MARGIN_MS;
    this.#runCanvas = options.runCanvas ?? renderCanvas;
    this.#runPipeline = options.runPipeline ?? runArtworkPipeline;
    this.#sleep = options.sleep ?? realSleep;
    this.#startedAt = this.#now();
    this.#lastActivityAt = this.#startedAt;
  }

  status(): WorkerStatus {
    return {
      inFlight: this.#inFlight.size,
      jobsCompleted: this.#jobsCompleted,
      jobsFailed: this.#jobsFailed,
      leaseHoldMs: Math.max(0, this.#leaseHoldUntil - this.#now()),
      polling: this.#armed,
      stopping: this.#stopping,
      uptimeMs: this.#now() - this.#startedAt,
    };
  }

  /** Arm the loop (starting it on first call) and restart the idle clock. */
  wake(): void {
    if (this.#stopping) {
      return;
    }
    this.#lastActivityAt = this.#now();
    if (!this.#armed) {
      this.#armed = true;
      this.#log("info", "polling_armed", {});
    }
    this.#loop ??= this.#run();
    this.#poke();
  }

  /** Stop asking for work; resolve once the jobs in flight have reported. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#armed = false;
    this.#poke();
    await this.#loop;
    await Promise.allSettled([...this.#inFlight]);
  }

  #poke(): void {
    const nudge = this.#nudge;
    this.#nudge = null;
    nudge?.();
  }

  /**
   * A job may stay leased to this container until `leaseEndMs` (container clock)
   * without being worked on here: do not disarm before it has expired.
   */
  #holdForLease(leaseEndMs: number, reason: string, ids: Record<string, number | string> = {}): void {
    const until = leaseEndMs + this.#leaseHoldMarginMs;
    if (until > this.#leaseHoldUntil) {
      this.#leaseHoldUntil = until;
    }
    this.#log("warn", "lease_hold", {
      ...ids,
      holdMs: Math.max(0, this.#leaseHoldUntil - this.#now()),
      reason,
    });
  }

  #parked(): Promise<void> {
    return new Promise((resolve) => {
      this.#nudge = resolve;
    });
  }

  async #run(): Promise<void> {
    while (!this.#stopping) {
      if (!this.#armed) {
        await this.#parked();
        continue;
      }
      if (this.#inFlight.size >= this.#maxConcurrentJobs) {
        await Promise.race([this.#parked(), ...this.#inFlight]);
        continue;
      }

      const started = this.#now();
      const result: AcquireResult = await this.#api.acquire();
      if (!this.#firstAcquireLogged) {
        this.#firstAcquireLogged = true;
        this.#log("info", "first_acquire", {
          outcome: result.kind,
          processUptimeMs: Math.round(process.uptime() * 1_000),
        });
      }

      if (result.kind === "lease") {
        this.#lastActivityAt = this.#now();
        const job = (
          leaseJobType(result.body) === CANVAS_JOB_TYPE
            ? this.#runCanvasJob(result.body, started)
            : this.#runJob(result.body, started)
        )
          .catch((error: unknown) => {
            // Only the unforeseen reaches here (every report path catches its own
            // failures); the job goes unreported, so hold until its lease expires.
            this.#jobsFailed += 1;
            this.#log("error", "job_crashed", {
              error: error instanceof Error ? error.name : "unknown",
            });
            this.#holdForLease(started + this.#assumedLeaseMs, "job_crashed");
          })
          .finally(() => {
            this.#inFlight.delete(job);
            this.#lastActivityAt = this.#now();
            this.#poke();
          });
        this.#inFlight.add(job);
        continue;
      }

      if (result.kind === "unavailable") {
        this.#log("warn", "acquire_unavailable", {
          code: result.code,
          retryAfterMs: result.retryAfterMs,
        });
        if (result.mayHaveLeased) {
          // Measured from when this acquire was SENT: a lease it may have made
          // cannot outlive that + the API's lease length.
          this.#holdForLease(started + this.#assumedLeaseMs, result.code);
        }
      }

      // Idle = no lease acquired and nothing running for the whole window, and no
      // lease possibly still held (THE LEASE HOLD). An acquire that keeps being
      // refused counts as idle, so a misconfigured container stops polling
      // instead of hammering a dark surface forever.
      if (
        this.#inFlight.size === 0 &&
        this.#now() - this.#lastActivityAt >= this.#idleExitMs &&
        this.#now() >= this.#leaseHoldUntil
      ) {
        this.#armed = false;
        this.#log("info", "polling_idle_exit", {
          idleMs: this.#now() - this.#lastActivityAt,
        });
        continue;
      }

      // Interruptible: wake() polls at once (a job was just queued) and stop()
      // does not wait out a back-off.
      await Promise.race([
        this.#sleep(result.kind === "unavailable" ? result.retryAfterMs : this.#pollIntervalMs),
        this.#parked(),
      ]);
      this.#nudge = null;
    }
  }

  async #runJob(body: unknown, acquiredAt: number): Promise<void> {
    const parsed = parseLease(body);
    // Without a readable lease end, the longest a lease made by this acquire can
    // last (acquiredAt is when the acquire was sent).
    const assumedLeaseEnd = acquiredAt + this.#assumedLeaseMs;
    if (!parsed.ok) {
      this.#jobsFailed += 1;
      if (parsed.claim === null) {
        // Nothing to report against; the lease expires and the API re-leases.
        this.#log("error", "job_envelope_unusable", {});
        this.#holdForLease(assumedLeaseEnd, "envelope_unusable");
        return;
      }
      this.#log("error", "job_envelope_invalid", {
        attempt: parsed.claim.attempt,
        jobId: parsed.claim.jobId,
      });
      await this.#fail(parsed.claim, "invalid_envelope", assumedLeaseEnd);
      return;
    }

    const lease = parsed.lease;
    const leaseEnd = Date.parse(lease.leaseUntil);
    const ids = { attempt: lease.attempt, jobId: lease.jobId };
    const alone = this.#inFlight.size === 0;
    // The resident high-water mark is per process; reset it only when this job is
    // the only one, so peakRssMb is this job's own peak (one job at a time is the
    // default). With several in flight it is the shared peak.
    const peakIsPerJob = alone && resetPeakRss();
    this.#log("info", "job_started", ids);

    const dir = await mkdtemp(join(tmpdir(), "render-job-"));
    const paths = {
      input: join(dir, "input"),
      preview: join(dir, "preview.webp"),
      print: join(dir, "print.png"),
    };
    const timings: Record<string, number> = {};
    const mark = (name: string, since: number) => {
      timings[name] = this.#now() - since;
    };

    try {
      let stage = this.#now();
      let inputBytes: number;
      try {
        inputBytes = await downloadToFile(
          this.#fetch,
          lease.inputUrl,
          // The job's bound and the container's own ceiling. Deliberately NOT the
          // profile's max_file_mb: an original over it must reach the pipeline's
          // size gate and get the Swedish `file_too_large` verdict, not a job
          // failure (it is streamed to disk, so the size costs no memory).
          Math.min(lease.inputMaxBytes, HARD_MAX_INPUT_BYTES),
          paths.input,
        );
      } catch (error) {
        await this.#failTransfer(lease, error, "input_fetch_failed", leaseEnd);
        return;
      }
      mark("fetchMs", stage);

      stage = this.#now();
      let result: PipelineResult;
      try {
        result = await this.#runPipeline(
          { bytes: inputBytes, path: paths.input },
          lease.profile,
          { previewPath: paths.preview, printPath: paths.print },
        );
      } catch (error) {
        this.#log("error", "pipeline_crashed", {
          ...ids,
          error: error instanceof Error ? error.name : "unknown",
          inputBytes,
        });
        await this.#fail(lease, "pipeline_crashed", leaseEnd);
        return;
      }
      mark("pipelineMs", stage);

      if (!result.ok) {
        const metrics = this.#metrics(acquiredAt, timings, { inputBytes }, peakIsPerJob);
        this.#log("info", "job_rejected", {
          ...ids,
          ...metrics,
          reasonCodes: result.reasons.map((reason) => reason.code),
        });
        await this.#complete(lease, completionBody(lease, result, metrics), leaseEnd);
        return;
      }

      stage = this.#now();
      let printPng: { bytes: number; sha256: string };
      let previewWebp: { bytes: number; sha256: string };
      try {
        printPng = await putFile(this.#fetch, lease.printPutUrl, paths.print, "image/png");
        previewWebp = await putFile(this.#fetch, lease.previewPutUrl, paths.preview, "image/webp");
      } catch (error) {
        await this.#failTransfer(lease, error, "output_put_failed", leaseEnd);
        return;
      }
      mark("uploadMs", stage);

      const metrics = this.#metrics(
        acquiredAt,
        timings,
        { inputBytes, previewBytes: previewWebp.bytes, printBytes: printPng.bytes },
        peakIsPerJob,
      );
      this.#log("info", "job_ok", {
        ...ids,
        ...metrics,
        effectiveDpi: result.meta.effectiveDpi,
        noticeCodes: result.notices.map((notice) => notice.code),
      });
      await this.#complete(
        lease,
        completionBody(
          lease,
          { meta: result.meta, notices: result.notices, ok: true, outputs: { previewWebp, printPng } },
          metrics,
        ),
        leaseEnd,
      );
    } finally {
      await rm(dir, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  #metrics(
    acquiredAt: number,
    timings: Record<string, number>,
    sizes: Record<string, number>,
    peakIsPerJob: boolean,
  ): Record<string, number> {
    const memory = memorySnapshotMb();
    return {
      ...timings,
      ...sizes,
      jobsSinceStart: this.#jobsCompleted + this.#jobsFailed + 1,
      peakIsPerJob: peakIsPerJob ? 1 : 0,
      peakRssMb: memory.peakRssMb,
      processUptimeMs: Math.round(process.uptime() * 1_000),
      rssMb: memory.rssMb,
      wallMs: this.#now() - acquiredAt,
    };
  }

  async #complete(
    lease: LeaseClaim,
    body: Record<string, unknown>,
    leaseEndMs: number,
    kind: "artwork" | "canvas" = "artwork",
  ): Promise<void> {
    const status = await this.#report(lease, "complete", body, leaseEndMs, undefined, kind);
    if (status === 200) {
      this.#jobsCompleted += 1;
      return;
    }
    this.#jobsFailed += 1;
    // 400: the API refused the body and left the lease alone — give the job back
    // now rather than letting the lease run out. 404 / 409 / 422 are settled by
    // the API (gone, someone else's, recorded as a failed attempt); an unsettled
    // status was abandoned and is held in #report.
    if (status === 400) {
      await this.#fail(lease, "completion_invalid", leaseEndMs, kind);
    }
  }

  async #fail(
    claim: LeaseClaim,
    code: FailureCode,
    leaseEndMs: number,
    kind: "artwork" | "canvas" = "artwork",
  ): Promise<void> {
    await this.#report(claim, "fail", failureBody(claim, code), leaseEndMs, code, kind);
  }

  /** One report, retried until the lease runs short; an abandoned one is held. */
  async #report(
    claim: LeaseClaim,
    action: "complete" | "fail",
    body: unknown,
    leaseEndMs: number,
    code?: FailureCode,
    kind: "artwork" | "canvas" = "artwork",
  ): Promise<ReportStatus> {
    const status =
      kind === "canvas"
        ? await this.#api.report(claim.jobId, action, body, leaseEndMs - this.#reportMarginMs, "canvas")
        : await this.#api.report(claim.jobId, action, body, leaseEndMs - this.#reportMarginMs);
    this.#logReport(action, claim, status, code);
    if (isUnsettled(status)) {
      this.#holdForLease(leaseEndMs, `report_${action}_abandoned`, {
        attempt: claim.attempt,
        jobId: claim.jobId,
      });
    }
    return status;
  }

  async #failTransfer(
    lease: LeaseClaim,
    error: unknown,
    fallback: FailureCode,
    leaseEndMs: number,
    kind: "artwork" | "canvas" = "artwork",
  ): Promise<void> {
    this.#jobsFailed += 1;
    const code = error instanceof TransferError ? error.code : fallback;
    this.#log("error", "job_transfer_failed", {
      attempt: lease.attempt,
      code,
      detail: error instanceof TransferError ? error.detail : "unknown",
      jobId: lease.jobId,
    });
    await this.#fail(lease, code, leaseEndMs, kind);
  }

  /** A `pod.print_canvas` job: see A CANVAS JOB above. */
  async #runCanvasJob(body: unknown, acquiredAt: number): Promise<void> {
    const parsed = parseCanvasLease(body);
    const assumedLeaseEnd = acquiredAt + this.#assumedLeaseMs;
    if (!parsed.ok) {
      this.#jobsFailed += 1;
      if (parsed.claim === null) {
        this.#log("error", "job_envelope_unusable", { jobType: CANVAS_JOB_TYPE });
        this.#holdForLease(assumedLeaseEnd, "envelope_unusable");
        return;
      }
      this.#log("error", "job_envelope_invalid", {
        attempt: parsed.claim.attempt,
        jobId: parsed.claim.jobId,
        jobType: CANVAS_JOB_TYPE,
      });
      await this.#fail(parsed.claim, "invalid_envelope", assumedLeaseEnd, "canvas");
      return;
    }

    const lease = parsed.lease;
    const leaseEnd = Date.parse(lease.leaseUntil);
    const ids = { attempt: lease.attempt, jobId: lease.jobId, jobType: CANVAS_JOB_TYPE };
    const peakIsPerJob = this.#inFlight.size === 0 && resetPeakRss();
    this.#log("info", "job_started", ids);

    const dir = await mkdtemp(join(tmpdir(), "canvas-job-"));
    const paths = { canvas: join(dir, "canvas.png"), input: join(dir, "input") };
    const timings: Record<string, number> = {};
    const mark = (name: string, since: number) => {
      timings[name] = this.#now() - since;
    };

    try {
      let stage = this.#now();
      let inputBytes: number;
      try {
        inputBytes = await downloadToFile(
          this.#fetch,
          lease.inputUrl,
          Math.min(lease.inputMaxBytes, CANVAS_MAX_INPUT_BYTES),
          paths.input,
        );
      } catch (error) {
        await this.#failTransfer(lease, error, "input_fetch_failed", leaseEnd, "canvas");
        return;
      }
      mark("fetchMs", stage);

      stage = this.#now();
      let result: Awaited<ReturnType<typeof renderCanvas>>;
      try {
        result = await this.#runCanvas({ path: paths.input, sha256: lease.inputSha256 }, lease.spec, paths.canvas);
      } catch (error) {
        this.#log("error", "pipeline_crashed", {
          ...ids,
          error: error instanceof Error ? error.name : "unknown",
          inputBytes,
        });
        await this.#fail(lease, "pipeline_crashed", leaseEnd, "canvas");
        return;
      }
      mark("pipelineMs", stage);

      if (!result.ok) {
        const metrics = this.#metrics(acquiredAt, timings, { inputBytes }, peakIsPerJob);
        this.#log("info", "job_rejected", { ...ids, ...metrics, reasonCodes: result.reasons.map((r) => r.code) });
        await this.#complete(lease, canvasCompletionBody(lease, result, metrics), leaseEnd, "canvas");
        return;
      }

      stage = this.#now();
      let canvasPng: { bytes: number; sha256: string };
      try {
        canvasPng = await putFile(this.#fetch, lease.canvasPutUrl, paths.canvas, "image/png");
      } catch (error) {
        await this.#failTransfer(lease, error, "output_put_failed", leaseEnd, "canvas");
        return;
      }
      mark("uploadMs", stage);

      const metrics = this.#metrics(acquiredAt, timings, { canvasBytes: canvasPng.bytes, inputBytes }, peakIsPerJob);
      this.#log("info", "job_ok", { ...ids, ...metrics });
      await this.#complete(
        lease,
        canvasCompletionBody(lease, { ok: true, output: canvasPng }, metrics),
        leaseEnd,
        "canvas",
      );
    } finally {
      await rm(dir, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  #logReport(
    action: "complete" | "fail",
    claim: LeaseClaim,
    status: ReportStatus,
    code?: FailureCode,
  ): void {
    this.#log(status === 200 ? "info" : "warn", `report_${action}`, {
      attempt: claim.attempt,
      jobId: claim.jobId,
      status: String(status),
      ...(code === undefined ? {} : { code }),
    });
  }
}
