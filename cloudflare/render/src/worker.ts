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
 * Logs are JSON lines: job id, attempt, codes, sizes, timings. Never the token,
 * never a URL, never a response body.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcquireResult, RenderApi, ReportStatus } from "./api.ts";
import {
  completionBody,
  failureBody,
  type FailureCode,
  HARD_MAX_INPUT_BYTES,
  type LeaseClaim,
  parseLease,
  type RenderLease,
} from "./contract.ts";
import type { Logger } from "./log.ts";
import { memorySnapshotMb, resetPeakRss } from "./metrics.ts";
import { runArtworkPipeline, type PipelineResult } from "./pipeline.ts";
import { downloadToFile, type FetchLike, putFile, TransferError } from "./transfer.ts";

export const POLL_INTERVAL_MS = 3_000;

export interface RenderWorkerOptions {
  api: Pick<RenderApi, "acquire" | "report">;
  /** For the two R2 transfers (the API calls go through `api`). */
  fetch: FetchLike;
  idleExitMs: number;
  log: Logger;
  maxConcurrentJobs: number;
  now?: () => number;
  pollIntervalMs?: number;
  /** Swappable for tests; the pipeline is the real one by default. */
  runPipeline?: typeof runArtworkPipeline;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkerStatus {
  inFlight: number;
  jobsCompleted: number;
  jobsFailed: number;
  polling: boolean;
  stopping: boolean;
  uptimeMs: number;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RenderWorker {
  readonly #api: Pick<RenderApi, "acquire" | "report">;
  readonly #fetch: FetchLike;
  readonly #idleExitMs: number;
  readonly #log: Logger;
  readonly #maxConcurrentJobs: number;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #runPipeline: typeof runArtworkPipeline;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #startedAt: number;

  #armed = false;
  #firstAcquireLogged = false;
  #inFlight = new Set<Promise<void>>();
  #jobsCompleted = 0;
  #jobsFailed = 0;
  #lastActivityAt: number;
  #loop: Promise<void> | null = null;
  #stopping = false;
  // Resolved to wake a loop parked on "disarmed" or "no free slot".
  #nudge: (() => void) | null = null;

  constructor(options: RenderWorkerOptions) {
    this.#api = options.api;
    this.#fetch = options.fetch;
    this.#idleExitMs = options.idleExitMs;
    this.#log = options.log;
    this.#maxConcurrentJobs = options.maxConcurrentJobs;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
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
        const job = this.#runJob(result.body, started)
          .catch((error: unknown) => {
            // Only the unforeseen reaches here (every report path catches its own
            // failures); the job goes unreported and its lease expiry takes over.
            this.#jobsFailed += 1;
            this.#log("error", "job_crashed", {
              error: error instanceof Error ? error.name : "unknown",
            });
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
      }

      // Idle = no lease acquired and nothing running for the whole window. An
      // acquire that keeps failing counts as idle too, so a misconfigured
      // container stops polling instead of hammering a dark surface forever.
      if (
        this.#inFlight.size === 0 &&
        this.#now() - this.#lastActivityAt >= this.#idleExitMs
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
    if (!parsed.ok) {
      this.#jobsFailed += 1;
      if (parsed.claim === null) {
        // Nothing to report against; the lease expires and the API re-leases.
        this.#log("error", "job_envelope_unusable", {});
        return;
      }
      this.#log("error", "job_envelope_invalid", {
        attempt: parsed.claim.attempt,
        jobId: parsed.claim.jobId,
      });
      await this.#fail(parsed.claim, "invalid_envelope");
      return;
    }

    const lease = parsed.lease;
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
        await this.#failTransfer(lease, error, "input_fetch_failed");
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
        await this.#fail(lease, "pipeline_crashed");
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
        await this.#complete(lease, completionBody(lease, result, metrics));
        return;
      }

      stage = this.#now();
      let printPng: { bytes: number; sha256: string };
      let previewWebp: { bytes: number; sha256: string };
      try {
        printPng = await putFile(this.#fetch, lease.printPutUrl, paths.print, "image/png");
        previewWebp = await putFile(this.#fetch, lease.previewPutUrl, paths.preview, "image/webp");
      } catch (error) {
        await this.#failTransfer(lease, error, "output_put_failed");
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

  async #complete(lease: RenderLease, body: Record<string, unknown>): Promise<void> {
    const status = await this.#api.report(lease.jobId, "complete", body);
    this.#logReport("complete", lease, status);
    if (status === 200) {
      this.#jobsCompleted += 1;
      return;
    }
    this.#jobsFailed += 1;
    // 400: the API refused the body and left the lease alone — give the job back
    // now rather than letting the lease run out. Everything else is already
    // settled by the API (404 gone, 409 someone else's, 422 recorded as a failed
    // attempt) or unreachable (the lease expiry takes over).
    if (status === 400) {
      await this.#fail(lease, "completion_invalid");
    }
  }

  async #fail(claim: LeaseClaim, code: FailureCode): Promise<void> {
    const status = await this.#api.report(claim.jobId, "fail", failureBody(claim, code));
    this.#logReport("fail", claim, status, code);
  }

  async #failTransfer(lease: RenderLease, error: unknown, fallback: FailureCode): Promise<void> {
    this.#jobsFailed += 1;
    const code = error instanceof TransferError ? error.code : fallback;
    this.#log("error", "job_transfer_failed", {
      attempt: lease.attempt,
      code,
      detail: error instanceof TransferError ? error.detail : "unknown",
      jobId: lease.jobId,
    });
    await this.#fail(lease, code);
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
