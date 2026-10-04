import { randomToken, sha256Hex } from "../lib/bearer";
import { nudgeOutbox } from "../outbox/nudge";
import {
  CANVAS_HOLD_UNTIL_MS,
  CANVAS_MAX_INPUT_BYTES,
  type CanvasJobState,
  type CanvasJobView,
  type CanvasSpec,
  canvasKey,
  canvasOutputPrefix,
  SNAPWEAR_MAX_CANVAS_BYTES,
} from "../dispatch/print-canvas";
import type { PrintLocation } from "../dispatch/snapwear-wire";
import { PRINT_CONTENT_TYPE, resolveR2Presigner } from "./render-farm-client";
import {
  ERROR_CODE_PATTERN,
  type LeaseClaim,
  parseLeaseClaim,
  parseMetrics,
  promote,
  RENDER_INPUT_URL_TTL_SECONDS,
  RENDER_JOB_LEASE_MS,
  RENDER_JOB_MAX_ATTEMPTS,
  RENDER_JOB_PROMOTION_MS,
} from "./render-jobs";

/**
 * The print canvas jobs (CP6-PS2, migration 0053): the render container's
 * second job kind, `pod.print_canvas`, and the record dispatch verifies a
 * canvas's bytes against.
 *
 * ── THE FLOW ────────────────────────────────────────────────────────────────
 *   1. The dispatcher, for a line it may send and whose canvases are missing,
 *      inserts one row per print slot (ensureCanvasJobStatements, INSERT OR
 *      IGNORE: a row is made once and never reset) in the batch that parks the
 *      dispatch row at CANVAS_HOLD_UNTIL_MS, then nudges RENDER_JOBS_QUEUE.
 *   2. The container acquires through the SAME /v1/render/jobs/acquire as the
 *      artwork jobs, but only when its body says it renders canvases
 *      (`{ jobTypes: [..., "pod.print_canvas"] }`): an older image never sees
 *      one. Artwork jobs go first (a seller is waiting at the screen).
 *   3. It reports to /v1/render/canvas-jobs/{id}/complete or /fail, fenced
 *      exactly as render jobs are (attempt + token hash + unexpired lease).
 *   4. A completion promotes the attempt object to the canonical key
 *      create-if-absent, with R2 verifying the reported sha256 (render-jobs.ts
 *      promote), and commits `completed` + canvas_sha256 + canvas_bytes.
 *
 * ── THE DISPATCH ROW FOLLOWS, ATOMICALLY ────────────────────────────────────
 * Every batch that SETTLES a job (completed, refused, failed on its last
 * attempt, reaped on an expired last lease) also makes the line's parked
 * dispatch row due (releaseStatement), and nudges the outbox after. On a
 * completion only when no sibling canvas of the line is still pending; on a
 * failure always (the dispatch then fails with its alert). The dispatcher's
 * park, for its part, applies only while one of the line's canvases is still
 * pending: D1 serialises writers, so the park's EXISTS and the release's NOT
 * EXISTS cannot both miss and leave a row parked for nothing.
 *
 * Nothing here is visible to a tenant or the public: the only callers are the
 * bearer-authenticated /v1/render surface and the dispatcher.
 */

export const CANVAS_JOB_TYPE = "pod.print_canvas";
export const CANVAS_CONTRACT_VERSION = 1;

interface CanvasJobRow {
  attempt: number;
  canvas_key: string;
  canvas_sha256: string | null;
  error: string | null;
  id: string;
  input_bytes: number;
  input_key: string;
  input_sha256: string;
  lease_token_hash: string | null;
  lease_until: string | null;
  line_no: number;
  order_id: string;
  output_prefix: string;
  slot: PrintLocation;
  spec_json: string;
  state: CanvasJobState;
  tenant_id: string;
}

const JOB_COLUMNS = `id, tenant_id, order_id, line_no, slot, attempt, state,
  lease_token_hash, lease_until, input_key, input_sha256, input_bytes, spec_json,
  output_prefix, canvas_key, canvas_sha256, error`;

const FENCE = `id = ? AND state = 'leased' AND attempt = ?
  AND lease_token_hash = ? AND lease_until > ?`;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function fenceBinds(jobId: string, attempt: number, tokenHash: string, atMs: number): unknown[] {
  return [jobId, attempt, tokenHash, iso(atMs)];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The attempt's output object, derived from the row, never from a request. */
export function canvasAttemptKey(outputPrefix: string, attempt: number): string {
  return `${outputPrefix}attempt-${attempt}/canvas.png`;
}

/** The dispatch row's dedupe key (the webhook's, dispatch-effect.ts header). */
function dispatchDedupeKey(orderId: string, lineNo: number): string {
  return `dispatch:${orderId}:${lineNo}`;
}

async function loadJob(db: D1Database, jobId: string): Promise<CanvasJobRow | null> {
  return db
    .prepare(`SELECT ${JOB_COLUMNS} FROM print_canvas_jobs WHERE id = ? LIMIT 1`)
    .bind(jobId)
    .first<CanvasJobRow>();
}

async function sweepAttempt(env: Env, outputPrefix: string, attempt: number): Promise<void> {
  if (env.PRIVATE_BUCKET === undefined || attempt < 1) {
    return;
  }
  await env.PRIVATE_BUCKET.delete(canvasAttemptKey(outputPrefix, attempt)).catch(() => undefined);
}

// ── the dispatcher's side ───────────────────────────────────────────────────

export interface EnsureCanvasSlot {
  inputBytes: number;
  inputKey: string;
  inputSha256: string;
  location: PrintLocation;
  spec: CanvasSpec;
}

/**
 * One INSERT OR IGNORE per slot. A row that exists (any state) stands: its
 * frozen spec and input are the line's for good (0053 refuses REPLACE and
 * upserts too). Returns the ids of the rows this batch may create, for the
 * render nudge.
 */
export function ensureCanvasJobStatements(
  db: D1Database,
  input: { lineNo: number; now: number; orderId: string; slots: EnsureCanvasSlot[]; tenantId: string },
): { jobIds: string[]; statements: D1PreparedStatement[] } {
  const nowIso = iso(input.now);
  const jobIds: string[] = [];
  const statements = input.slots.map((slot) => {
    const id = crypto.randomUUID();
    jobIds.push(id);
    return db
      .prepare(
        `INSERT OR IGNORE INTO print_canvas_jobs (
           id, tenant_id, order_id, line_no, slot, attempt, state,
           input_key, input_sha256, input_bytes, spec_json, output_prefix,
           canvas_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.tenantId,
        input.orderId,
        input.lineNo,
        slot.location,
        slot.inputKey,
        slot.inputSha256,
        slot.inputBytes,
        JSON.stringify(slot.spec),
        canvasOutputPrefix(input.tenantId, input.orderId, input.lineNo, slot.location),
        canvasKey(input.tenantId, input.orderId, input.lineNo, slot.location),
        nowIso,
        nowIso,
      );
  });
  return { jobIds, statements };
}

export interface LineCanvas extends CanvasJobView {
  id: string;
  inputKey: string;
  inputSha256: string;
}

/** Every canvas job of one line (at most one per slot, by 0053's UNIQUE). */
export async function readLineCanvases(
  db: D1Database,
  tenantId: string,
  orderId: string,
  lineNo: number,
): Promise<LineCanvas[]> {
  const rows = await db
    .prepare(
      `SELECT id, slot, state, canvas_key, canvas_sha256, error, input_key, input_sha256
       FROM print_canvas_jobs
       WHERE tenant_id = ? AND order_id = ? AND line_no = ?
       ORDER BY slot`,
    )
    .bind(tenantId, orderId, lineNo)
    .all<{
      canvas_key: string;
      canvas_sha256: string | null;
      error: string | null;
      id: string;
      input_key: string;
      input_sha256: string;
      slot: PrintLocation;
      state: CanvasJobState;
    }>();
  return rows.results.map((row) => ({
    canvasKey: row.canvas_key,
    canvasSha256: row.canvas_sha256,
    error: row.error,
    id: row.id,
    inputKey: row.input_key,
    inputSha256: row.input_sha256,
    slot: row.slot,
    state: row.state,
  }));
}

/** SQL: one of the line's canvases is still to be made. */
export function lineCanvasPendingSql(): string {
  return `EXISTS (
    SELECT 1 FROM print_canvas_jobs AS pending
    WHERE pending.tenant_id = ? AND pending.order_id = ? AND pending.line_no = ?
      AND pending.state IN ('queued', 'leased')
  )`;
}

/**
 * Make the line's canvas-parked dispatch row due, inside the batch that settles
 * a job. `when` is the condition (SQL + binds) under which the release applies
 * — the settling statement's own success, so a fenced-out batch releases
 * nothing. `settled` additionally requires that no sibling canvas is pending
 * (a completion); a failure releases at once.
 */
function releaseStatement(
  db: D1Database,
  line: { lineNo: number; orderId: string; tenantId: string },
  nowMs: number,
  options: { requireAllSettled: boolean; when: { binds: unknown[]; sql: string } },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE outbox_events
       SET next_attempt_at = ?, updated_at = MAX(updated_at, ?)
       WHERE event_type = 'dispatch' AND tenant_id = ? AND dedupe_key = ?
         AND status = 'pending' AND next_attempt_at = ${CANVAS_HOLD_UNTIL_MS}
         ${options.requireAllSettled ? `AND NOT ${lineCanvasPendingSql()}` : ""}
         AND ${options.when.sql}
       RETURNING outbox_id`,
    )
    .bind(
      nowMs,
      nowMs,
      line.tenantId,
      dispatchDedupeKey(line.orderId, line.lineNo),
      ...(options.requireAllSettled ? [line.tenantId, line.orderId, line.lineNo] : []),
      ...options.when.binds,
    );
}

function releasedIds(result: D1Result<unknown> | undefined): string[] {
  return ((result?.results ?? []) as Array<{ outbox_id: string }>).map((row) => row.outbox_id);
}

function lineOf(job: CanvasJobRow): { lineNo: number; orderId: string; tenantId: string } {
  return { lineNo: job.line_no, orderId: job.order_id, tenantId: job.tenant_id };
}

/** "This attempt settled the job in `state`", for statements after the settling one. */
function settledByThisAttempt(
  job: CanvasJobRow,
  claim: LeaseClaim,
  tokenHash: string,
  state: "completed" | "failed",
): { binds: unknown[]; sql: string } {
  return {
    binds: [job.id, state, claim.attempt, tokenHash],
    sql: `EXISTS (
      SELECT 1 FROM print_canvas_jobs
      WHERE id = ? AND state = ? AND attempt = ? AND lease_token_hash = ?
    )`,
  };
}

// ── the sweeper's side ──────────────────────────────────────────────────────

/**
 * Backstop: any canvas-parked dispatch row whose line has no pending canvas
 * left becomes due (the release in the settling batch makes this a no-op in
 * practice). Bounded per sweep.
 */
export async function releaseSettledCanvasHolds(db: D1Database, now: number, limit: number): Promise<string[]> {
  const result = await db
    .prepare(
      `UPDATE outbox_events
       SET next_attempt_at = ?, updated_at = MAX(updated_at, ?)
       WHERE outbox_id IN (
         SELECT e.outbox_id FROM outbox_events AS e
         WHERE e.event_type = 'dispatch' AND e.status = 'pending'
           AND e.next_attempt_at = ${CANVAS_HOLD_UNTIL_MS}
           AND NOT EXISTS (
             SELECT 1 FROM print_canvas_jobs AS j
             WHERE j.tenant_id = e.tenant_id
               AND 'dispatch:' || j.order_id || ':' || j.line_no = e.dedupe_key
               AND j.state IN ('queued', 'leased')
           )
         ORDER BY e.created_at, e.outbox_id
         LIMIT ${limit}
       )
       RETURNING outbox_id`,
    )
    .bind(now, now)
    .all<{ outbox_id: string }>();
  return result.results.map((row) => row.outbox_id);
}

/** The oldest canvas job waiting for the container, if it waited this long. */
export async function staleCanvasJobId(db: D1Database, now: number, staleMs: number): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM print_canvas_jobs
       WHERE (state = 'queued' AND updated_at < ?)
          OR (state = 'leased' AND lease_until < ?)
       ORDER BY created_at, id
       LIMIT 1`,
    )
    .bind(iso(now - staleMs), iso(now))
    .first<{ id: string }>();
  return row?.id ?? null;
}

// ── acquire ─────────────────────────────────────────────────────────────────

export interface CanvasJobLease {
  attempt: number;
  contract: number;
  input: { maxBytes: number; sha256: string; url: string };
  jobId: string;
  jobType: typeof CANVAS_JOB_TYPE;
  leaseToken: string;
  leaseUntil: string;
  output: { canvasPngPutUrl: string };
  outputPrefix: string;
  spec: CanvasSpec;
}

/**
 * Lease the oldest acquirable canvas job, or null. One batch, like
 * acquireRenderJob: expired leases already on their last attempt are ended
 * (and their lines' dispatch rows released), then the oldest queued job or
 * expired lease is leased with attempt + 1 and a fresh token.
 */
export async function acquireCanvasJob(env: Env, db: D1Database, now: number): Promise<CanvasJobLease | null> {
  const nowIso = iso(now);
  const leaseUntil = iso(now + RENDER_JOB_LEASE_MS);
  const leaseToken = randomToken();
  const tokenHash = await sha256Hex(leaseToken);
  const reapWhere = `state = 'leased' AND lease_until < ? AND attempt >= ${RENDER_JOB_MAX_ATTEMPTS}`;

  const results = await db.batch([
    // Read before the jobs leave 'leased': release their lines' dispatch rows.
    db
      .prepare(
        `UPDATE outbox_events
         SET next_attempt_at = ?, updated_at = MAX(updated_at, ?)
         WHERE event_type = 'dispatch' AND status = 'pending'
           AND next_attempt_at = ${CANVAS_HOLD_UNTIL_MS}
           AND (tenant_id, dedupe_key) IN (
             SELECT tenant_id, 'dispatch:' || order_id || ':' || line_no
             FROM print_canvas_jobs WHERE ${reapWhere}
           )
         RETURNING outbox_id`,
      )
      .bind(now, now, nowIso),
    db
      .prepare(
        `UPDATE print_canvas_jobs
         SET state = 'failed', error = 'lease_expired', updated_at = MAX(updated_at, ?)
         WHERE ${reapWhere}
         RETURNING id, output_prefix, attempt`,
      )
      .bind(nowIso, nowIso),
    db
      .prepare(
        `UPDATE print_canvas_jobs
         SET state = 'leased',
             attempt = attempt + 1,
             lease_token_hash = ?,
             lease_until = ?,
             error = CASE WHEN state = 'leased' THEN 'lease_expired' ELSE error END,
             updated_at = MAX(updated_at, ?)
         WHERE id = (
           SELECT id FROM print_canvas_jobs
           WHERE state = 'queued' OR (state = 'leased' AND lease_until < ?)
           ORDER BY created_at, id
           LIMIT 1
         )
         RETURNING ${JOB_COLUMNS}`,
      )
      .bind(tokenHash, leaseUntil, nowIso, nowIso),
  ]);

  await nudgeOutbox(env, releasedIds(results[0]));
  const reaped = (results[1]?.results ?? []) as Array<{ attempt: number; output_prefix: string }>;
  await Promise.all(reaped.map((job) => sweepAttempt(env, job.output_prefix, job.attempt)));

  const job = (results[2]?.results ?? [])[0] as CanvasJobRow | undefined;
  if (job === undefined) {
    return null;
  }
  if (job.attempt > 1) {
    await sweepAttempt(env, job.output_prefix, job.attempt - 1);
  }

  const presigner = resolveR2Presigner(env);
  const [inputUrl, canvasPngPutUrl] = await Promise.all([
    presigner.presignGet(job.input_key, RENDER_INPUT_URL_TTL_SECONDS),
    presigner.presignPut(canvasAttemptKey(job.output_prefix, job.attempt), PRINT_CONTENT_TYPE),
  ]);

  return {
    attempt: job.attempt,
    contract: CANVAS_CONTRACT_VERSION,
    input: {
      maxBytes: Math.min(job.input_bytes, CANVAS_MAX_INPUT_BYTES),
      sha256: job.input_sha256,
      url: inputUrl,
    },
    jobId: job.id,
    jobType: CANVAS_JOB_TYPE,
    leaseToken,
    leaseUntil,
    output: { canvasPngPutUrl },
    outputPrefix: `${job.output_prefix}attempt-${job.attempt}/`,
    spec: JSON.parse(job.spec_json) as CanvasSpec,
  };
}

// ── reports: fencing ────────────────────────────────────────────────────────

function isFresh(job: CanvasJobRow, claim: LeaseClaim, tokenHash: string, nowIso: string): boolean {
  return (
    job.state === "leased" &&
    claim.attempt === job.attempt &&
    job.lease_token_hash === tokenHash &&
    job.lease_until !== null &&
    job.lease_until > nowIso
  );
}

function isSettledBy(job: CanvasJobRow, claim: LeaseClaim, tokenHash: string): "completed" | "failed" | null {
  return (job.state === "completed" || job.state === "failed") &&
    claim.attempt === job.attempt &&
    job.lease_token_hash === tokenHash
    ? job.state
    : null;
}

async function refuseStale(
  env: Env,
  job: CanvasJobRow,
  claim: LeaseClaim,
  tokenHash: string,
): Promise<{ status: "stale" }> {
  const dead =
    claim.attempt < job.attempt ||
    (claim.attempt === job.attempt && job.lease_token_hash === tokenHash && job.state !== "completed");
  if (dead) {
    await sweepAttempt(env, job.output_prefix, claim.attempt);
  }
  return { status: "stale" };
}

/**
 * End the job `failed` with `error` under the fence, releasing its line's
 * dispatch row in the same batch. "stale" when the fence no longer holds.
 */
async function failTerminal(
  env: Env,
  db: D1Database,
  job: CanvasJobRow,
  claim: LeaseClaim,
  tokenHash: string,
  error: string,
): Promise<"failed" | "stale"> {
  const nowMs = Date.now();
  const results = await db.batch([
    db
      .prepare(`UPDATE print_canvas_jobs SET state = 'failed', error = ?, updated_at = MAX(updated_at, ?) WHERE ${FENCE}`)
      .bind(error, iso(nowMs), ...fenceBinds(job.id, claim.attempt, tokenHash, nowMs)),
    releaseStatement(db, lineOf(job), nowMs, {
      requireAllSettled: false,
      when: settledByThisAttempt(job, claim, tokenHash, "failed"),
    }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return "stale";
  }
  await sweepAttempt(env, job.output_prefix, claim.attempt);
  await nudgeOutbox(env, releasedIds(results[1]));
  return "failed";
}

/** One attempt produced nothing usable: requeue while attempts remain, else end it. */
async function recordAttemptFailure(
  env: Env,
  db: D1Database,
  job: CanvasJobRow,
  claim: LeaseClaim,
  tokenHash: string,
  error: string,
): Promise<"failed" | "queued" | "stale"> {
  if (claim.attempt >= RENDER_JOB_MAX_ATTEMPTS) {
    return failTerminal(env, db, job, claim, tokenHash, error);
  }
  const nowMs = Date.now();
  const requeued = await db
    .prepare(
      `UPDATE print_canvas_jobs
       SET state = 'queued', lease_token_hash = NULL, lease_until = NULL, error = ?, updated_at = MAX(updated_at, ?)
       WHERE ${FENCE}`,
    )
    .bind(error, iso(nowMs), ...fenceBinds(job.id, claim.attempt, tokenHash, nowMs))
    .run();
  if ((requeued.meta.changes ?? 0) === 0) {
    return "stale";
  }
  await sweepAttempt(env, job.output_prefix, claim.attempt);
  return "queued";
}

// ── fail ────────────────────────────────────────────────────────────────────

export type FailCanvasJobResult = { status: "failed" | "invalid" | "not_found" | "queued" | "stale" };

const FAIL_KEYS = ["attempt", "error", "leaseToken"] as const;

/** `{ attempt, leaseToken, error }`: the container could not produce a result. */
export async function failCanvasJob(
  env: Env,
  db: D1Database,
  jobId: string,
  body: unknown,
  now: number,
): Promise<FailCanvasJobResult> {
  const claim = parseLeaseClaim(body, FAIL_KEYS);
  const error = isPlainObject(body) ? body.error : undefined;
  if (claim === null || typeof error !== "string" || !ERROR_CODE_PATTERN.test(error)) {
    return { status: "invalid" };
  }
  const job = await loadJob(db, jobId);
  if (job === null) {
    return { status: "not_found" };
  }
  const tokenHash = await sha256Hex(claim.leaseToken);
  if (!isFresh(job, claim, tokenHash, iso(now))) {
    return refuseStale(env, job, claim, tokenHash);
  }
  return { status: await recordAttemptFailure(env, db, job, claim, tokenHash, error) };
}

// ── complete ────────────────────────────────────────────────────────────────

export type CompleteCanvasJobResult = {
  status:
    | "canonical_conflict"
    | "completed"
    | "invalid"
    | "not_found"
    | "outputs_unverified"
    | "refused"
    | "stale"
    | "too_large";
};

const COMPLETE_KEYS = ["attempt", "leaseToken", "metrics", "ok", "outputs", "reasons"] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REASONS = 10;

type CanvasReport =
  | { code: string; status: "refused" }
  | { bytes: number; sha256: string; status: "ok" };

/**
 * ok:true  → outputs EXACTLY { canvasPng: { key, bytes, sha256 } }, the key
 *            being this attempt's own (derived from the row, never trusted);
 * ok:false → reasons [{ code, message? }]: a DETERMINISTIC refusal (the
 *            input is not the frozen file, its pixels differ, the motif cannot
 *            fit). Retrying cannot fix it, so the job ends at once.
 */
function parseCanvasReport(body: Record<string, unknown>, expectedKey: string): CanvasReport | null {
  if (body.ok === false) {
    const { reasons } = body;
    if (body.outputs !== undefined || !Array.isArray(reasons) || reasons.length < 1 || reasons.length > MAX_REASONS) {
      return null;
    }
    const first = reasons[0] as unknown;
    if (
      !reasons.every(
        (reason) =>
          isPlainObject(reason) &&
          Object.keys(reason).every((key) => key === "code" || key === "message") &&
          typeof reason.code === "string" &&
          ERROR_CODE_PATTERN.test(reason.code) &&
          (reason.message === undefined || (typeof reason.message === "string" && reason.message.length <= 500)),
      ) ||
      !isPlainObject(first)
    ) {
      return null;
    }
    return { code: first.code as string, status: "refused" };
  }
  if (body.ok !== true || body.reasons !== undefined || !isPlainObject(body.outputs)) {
    return null;
  }
  const outputs = body.outputs;
  const canvas = outputs.canvasPng;
  if (
    Object.keys(outputs).length !== 1 ||
    !isPlainObject(canvas) ||
    Object.keys(canvas).length !== 3 ||
    canvas.key !== expectedKey ||
    typeof canvas.bytes !== "number" ||
    !Number.isSafeInteger(canvas.bytes) ||
    canvas.bytes < 1 ||
    typeof canvas.sha256 !== "string" ||
    !SHA256_PATTERN.test(canvas.sha256)
  ) {
    return null;
  }
  return { bytes: canvas.bytes, sha256: canvas.sha256, status: "ok" };
}

/**
 * `POST /v1/render/canvas-jobs/{id}/complete`.
 *
 *   fenced? ─ no ─→ replay of the report that settled it → its answer again;
 *                   anything else → "stale" (+ sweep of a dead attempt)
 *   body valid? ─ no → "invalid" (lease untouched; the container may resend)
 *   fence + extend for the promotion window
 *   ok:false          → job failed with the reason's code, dispatch released → "refused"
 *   over 100 MiB (C3) → job failed `print_canvas_too_large`, released        → "too_large"
 *   ok:true           → HEAD the attempt object (size) → promote (R2 verifies
 *                       the sha256) → completed + canvas_sha256/bytes + release
 *   unverified output → the attempt failed (requeue / fail after 3)
 *   canonical conflict→ the job fails now: a different canvas exists, never overwritten
 */
export async function completeCanvasJob(
  env: Env,
  db: D1Database,
  jobId: string,
  body: unknown,
  now: number,
): Promise<CompleteCanvasJobResult> {
  const claim = parseLeaseClaim(body, COMPLETE_KEYS);
  if (claim === null) {
    return { status: "invalid" };
  }
  const record = body as Record<string, unknown>;
  const job = await loadJob(db, jobId);
  if (job === null) {
    return { status: "not_found" };
  }
  const tokenHash = await sha256Hex(claim.leaseToken);
  const settled = isSettledBy(job, claim, tokenHash);
  if (settled === "completed") {
    return { status: "completed" };
  }
  if (!isFresh(job, claim, tokenHash, iso(now))) {
    return refuseStale(env, job, claim, tokenHash);
  }

  const attemptKey = canvasAttemptKey(job.output_prefix, claim.attempt);
  const report = parseCanvasReport(record, attemptKey);
  const metrics = parseMetrics(record.metrics);
  if (report === null || metrics === null) {
    return { status: "invalid" };
  }

  const extended = await db
    .prepare(`UPDATE print_canvas_jobs SET lease_until = MAX(lease_until, ?), updated_at = MAX(updated_at, ?) WHERE ${FENCE}`)
    .bind(iso(now + RENDER_JOB_PROMOTION_MS), iso(now), ...fenceBinds(job.id, claim.attempt, tokenHash, now))
    .run();
  if ((extended.meta.changes ?? 0) === 0) {
    return { status: "stale" };
  }

  if (metrics !== undefined) {
    console.log(JSON.stringify({ attempt: claim.attempt, jobId: job.id, message: "canvas job metrics", metrics }));
  }

  if (report.status === "refused") {
    return { status: (await failTerminal(env, db, job, claim, tokenHash, report.code)) === "failed" ? "refused" : "stale" };
  }
  if (report.bytes > SNAPWEAR_MAX_CANVAS_BYTES) {
    const ended = await failTerminal(env, db, job, claim, tokenHash, "print_canvas_too_large");
    return { status: ended === "failed" ? "too_large" : "stale" };
  }

  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined) {
    throw new Error("render jobs surface is not configured");
  }
  const head = await bucket.head(attemptKey);
  if (head === null || head.size !== report.bytes) {
    const outcome = await recordAttemptFailure(env, db, job, claim, tokenHash, "outputs_unverified");
    return { status: outcome === "stale" ? "stale" : "outputs_unverified" };
  }

  const promotion = await promote(bucket, attemptKey, job.canvas_key, report, PRINT_CONTENT_TYPE);
  if (promotion === "conflict") {
    const ended = await failTerminal(env, db, job, claim, tokenHash, "canonical_conflict");
    return { status: ended === "failed" ? "canonical_conflict" : "stale" };
  }
  if (promotion === "unverified") {
    const outcome = await recordAttemptFailure(env, db, job, claim, tokenHash, "outputs_unverified");
    return { status: outcome === "stale" ? "stale" : "outputs_unverified" };
  }

  const nowMs = Date.now();
  const nowIso = iso(nowMs);
  const results = await db.batch([
    db
      .prepare(
        `UPDATE print_canvas_jobs
         SET state = 'completed', canvas_sha256 = ?, canvas_bytes = ?, completed_at = ?,
             error = NULL, updated_at = MAX(updated_at, ?)
         WHERE ${FENCE}`,
      )
      .bind(report.sha256, report.bytes, nowIso, nowIso, ...fenceBinds(job.id, claim.attempt, tokenHash, nowMs)),
    releaseStatement(db, lineOf(job), nowMs, {
      requireAllSettled: true,
      when: settledByThisAttempt(job, claim, tokenHash, "completed"),
    }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    const current = await loadJob(db, job.id);
    return current !== null && isSettledBy(current, claim, tokenHash) === "completed"
      ? { status: "completed" }
      : { status: "stale" };
  }
  await sweepAttempt(env, job.output_prefix, claim.attempt);
  await nudgeOutbox(env, releasedIds(results[1]));
  return { status: "completed" };
}
