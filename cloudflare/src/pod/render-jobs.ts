import { randomToken, sha256Hex } from "../lib/bearer";
import type {
  JobEnvelope,
  JobMeta,
  JobNotice,
  JobOutputReport,
  JobProfile,
} from "./render-farm-client";
import {
  buildJobEnvelope,
  isR2PresignerConfigured,
  parseFarmResult,
  PREVIEW_CONTENT_TYPE,
  PRINT_CONTENT_TYPE,
  resolveR2Presigner,
} from "./render-farm-client";

/**
 * Render jobs with lease fencing — PLAN §2.6, migration 0017.
 *
 * ── THE FLOW ────────────────────────────────────────────────────────────────
 *   1. Artwork creation inserts a 'processing' pod_artwork row and a 'queued'
 *      render_jobs row in ONE batch (insertRenderJobStatement), then nudges
 *      RENDER_JOBS_QUEUE. The row is the truth; the message is a hint.
 *   2. The farm PULLS: acquireRenderJob leases the oldest acquirable job and
 *      hands back the contract-v0 envelope (same fields the synchronous
 *      dispatch sent, so the farm's validator and pipeline are reused as they
 *      are) plus { attempt, leaseToken, leaseUntil, outputPrefix }. The PUT URLs
 *      point at ATTEMPT-SPECIFIC keys under outputPrefix.
 *   3. The farm reports: completeRenderJob with the farm's own verdict body
 *      (`{ ok, fields, notices, outputs }` / `{ ok:false, reasons }`) plus the
 *      lease fields, or failRenderJob with an error code.
 *   4. A completion is accepted ONLY while attempt == current AND the token
 *      matches AND the lease has not expired. The verified attempt outputs are
 *      then PROMOTED (copied, with R2 verifying the reported sha256) to the
 *      canonical keys, and the job + artwork row + audit commit in one batch.
 *
 * ── WHY PROMOTION IS SAFE WITHOUT A 'PROMOTING' STATE ───────────────────────
 * Promotion touches R2, which no D1 batch can include. So a fresh completion
 * first FENCES AND EXTENDS its lease (one conditional UPDATE): from that moment
 * no other attempt can be leased for RENDER_JOB_PROMOTION_MS, so nothing else
 * can write the canonical keys while this request copies to them. The commit
 * batch re-checks the fence against the clock at commit time. Canonical keys
 * are immutable, and the lease is NOT what enforces that: a promotion can stall
 * past its lease, so the canonical write itself is create-if-absent
 * (`If-None-Match: *`, see promote). An existing object with a different
 * sha256 is a conflict that ends the job (alert), never an overwrite.
 *
 * ── WHAT THE FARM IS TOLD ───────────────────────────────────────────────────
 * Nothing the farm reports is echoed back, and nothing about a job is visible
 * to anyone but the farm (the only caller of these functions is the
 * bearer-authenticated /v1/render surface).
 */

export const RENDER_JOB_MAX_ATTEMPTS = 3;

/**
 * How long one attempt owns a job. The farm's own ceiling is 300 s per job
 * (render-farm-client.ts FARM_TIMEOUT_MS reasoning); twice that absorbs cold
 * start, the input download and the output PUTs. The presigned PUT URLs live
 * PRESIGN_TTL_SECONDS (900 s) — longer than the lease, deliberately: a farm
 * that overruns its lease can still finish its PUTs, but only into its OWN
 * attempt prefix, where they cannot collide with the next attempt's.
 */
export const RENDER_JOB_LEASE_MS = 10 * 60 * 1_000;

/**
 * The window a fenced completion reserves for copying its outputs to the
 * canonical keys. Two objects, R2 to R2 through the binding — seconds in
 * practice; two minutes leaves a wide margin.
 */
export const RENDER_JOB_PROMOTION_MS = 2 * 60 * 1_000;

/** The input GET is fetched at the start of the job; it need not live long. */
export const RENDER_INPUT_URL_TTL_SECONDS = 300;

/** Artwork creation renders version 1. See 0017 on `version`. */
export const INITIAL_RENDER_VERSION = 1;

/**
 * RENDER_FARM_TOKEN authenticates the farm TO this worker on the pull surface,
 * which makes it an inbound credential like BOOTSTRAP_TOKEN — so it is held to
 * the same 32-character floor, stricter than the 16 isPodConfigured asks of it
 * as an outbound secret.
 */
export const MINIMUM_FARM_TOKEN_LENGTH = 32;

const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const METRIC_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_METRICS = 20;

/**
 * Whether the /v1/render surface exists at all. Everything it needs, or it is
 * a 404: the inbound token, the presigner (acquire signs URLs) and the private
 * bucket binding (completion verifies and promotes through it).
 */
export function isRenderJobsConfigured(env: Env): boolean {
  return (
    typeof env.RENDER_FARM_TOKEN === "string" &&
    env.RENDER_FARM_TOKEN.length >= MINIMUM_FARM_TOKEN_LENGTH &&
    isR2PresignerConfigured(env) &&
    env.PRIVATE_BUCKET !== undefined
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ── keys ────────────────────────────────────────────────────────────────────

/**
 * The canonical output keys an artwork row names. The same format the
 * synchronous dispatch has always written, so both paths produce identical
 * rows. Version 1 only: a future reprocess (version 2) must version these keys,
 * and until it does a second version would hit the immutability check below
 * and fail closed rather than overwrite.
 */
export function canonicalOutputKeys(
  tenantId: string,
  artworkId: string,
): { previewKey: string; printKey: string } {
  return {
    previewKey: `pod/${tenantId}/preview/${artworkId}.webp`,
    printKey: `pod/${tenantId}/print/${artworkId}.png`,
  };
}

export function renderOutputPrefix(
  tenantId: string,
  artworkId: string,
  version: number,
): string {
  return `pod/${tenantId}/render/${artworkId}/${version}/`;
}

export function attemptOutputKeys(
  outputPrefix: string,
  attempt: number,
): { prefix: string; previewKey: string; printKey: string } {
  const prefix = `${outputPrefix}attempt-${attempt}/`;
  return {
    prefix,
    previewKey: `${prefix}preview.webp`,
    printKey: `${prefix}print.png`,
  };
}

// ── enqueue ─────────────────────────────────────────────────────────────────

/** The job row, for the artwork creation batch (src/pod/artwork-store.ts). */
export function insertRenderJobStatement(
  db: D1Database,
  input: {
    artworkId: string;
    inputBytes: number;
    inputKey: string;
    jobId: string;
    now: number;
    profile: JobProfile;
    tenantId: string;
  },
): D1PreparedStatement {
  const nowIso = iso(input.now);
  return db
    .prepare(
      `INSERT INTO render_jobs (
         id, tenant_id, artwork_id, version, attempt, state, input_key,
         input_bytes, profile_json, output_prefix, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, 'queued', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.jobId,
      input.tenantId,
      input.artworkId,
      INITIAL_RENDER_VERSION,
      input.inputKey,
      input.inputBytes,
      JSON.stringify(input.profile),
      renderOutputPrefix(input.tenantId, input.artworkId, INITIAL_RENDER_VERSION),
      nowIso,
      nowIso,
    );
}

/**
 * The queue nudge. Best-effort by design: the row committed before this runs,
 * the farm pulls whether or not a message exists, and failing the admin's
 * request here would report a failure for work that is already queued.
 */
export async function nudgeRenderJob(env: Env, jobId: string): Promise<void> {
  if (env.RENDER_JOBS_QUEUE === undefined) {
    return;
  }

  try {
    await env.RENDER_JOBS_QUEUE.send({ renderJobId: jobId }, { contentType: "json" });
  } catch (error) {
    console.warn(
      JSON.stringify({
        error: error instanceof Error ? error.name : "unknown",
        jobId,
        message: "render job nudge could not be enqueued",
      }),
    );
  }
}

// ── rows ────────────────────────────────────────────────────────────────────

type RenderJobState = "completed" | "failed" | "leased" | "queued";

interface RenderJobRow {
  artwork_id: string;
  attempt: number;
  id: string;
  input_bytes: number;
  input_key: string;
  lease_token_hash: string | null;
  lease_until: string | null;
  output_prefix: string;
  profile_json: string;
  state: RenderJobState;
  tenant_id: string;
  version: number;
}

const JOB_COLUMNS = `id, tenant_id, artwork_id, version, attempt, state,
  lease_token_hash, lease_until, input_key, input_bytes, profile_json,
  output_prefix`;

async function loadJob(db: D1Database, jobId: string): Promise<RenderJobRow | null> {
  return db
    .prepare(`SELECT ${JOB_COLUMNS} FROM render_jobs WHERE id = ? LIMIT 1`)
    .bind(jobId)
    .first<RenderJobRow>();
}

/**
 * The fence. Every state change a farm report causes is conditioned on it, so a
 * report that was fresh when it was read but lost its lease before it wrote
 * changes nothing.
 */
const FENCE = `id = ? AND state = 'leased' AND attempt = ?
  AND lease_token_hash = ? AND lease_until > ?`;

function fenceBinds(
  jobId: string,
  attempt: number,
  tokenHash: string,
  atMs: number,
): unknown[] {
  return [jobId, attempt, tokenHash, iso(atMs)];
}

/**
 * The statements that END a job: alert, tenant audit, removal of the tenant's
 * still-'processing' artwork row (so the same upload can be posted again — the
 * "replay is the retry" rule of the synchronous path), and the job → 'failed'.
 * `where` selects the jobs being ended; the alert and audit ids are derived
 * from the job id, so a job can never raise its alert twice.
 *
 * Order matters: the three statements that read the jobs run before the one
 * that moves them out of 'leased'. The last statement RETURNs what was ended.
 */
function terminalFailureStatements(
  db: D1Database,
  where: string,
  binds: unknown[],
  error: string,
  nowMs: number,
): D1PreparedStatement[] {
  const nowIso = iso(nowMs);
  return [
    db
      .prepare(
        `INSERT INTO alerts (
           id, tenant_id, kind, severity, message, resource_type, resource_id,
           created_at
         )
         SELECT 'render-job-failed:' || id, tenant_id, 'render_job_failed',
                'critical',
                'Render job ' || id || ' for artwork ' || artwork_id
                  || ' failed on attempt ' || attempt || ' (' || ? || ')',
                'render_job', id, ?
         FROM render_jobs WHERE ${where}`,
      )
      .bind(error, nowIso, ...binds),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT 'render-job-failed:' || id, tenant_id, NULL,
                'pod.artwork.render_failed', 'pod_artwork', artwork_id, id,
                json_object('attempt', attempt, 'error', ?, 'renderJobId', id),
                ?
         FROM render_jobs WHERE ${where}`,
      )
      .bind(error, nowMs, ...binds),
    db
      .prepare(
        `DELETE FROM pod_artwork
         WHERE status = 'processing'
           AND (tenant_id, artwork_id) IN (
             SELECT tenant_id, artwork_id FROM render_jobs WHERE ${where}
           )`,
      )
      .bind(...binds),
    db
      .prepare(
        `UPDATE render_jobs
         SET state = 'failed', error = ?, updated_at = ?
         WHERE ${where}
         RETURNING id, output_prefix, attempt`,
      )
      .bind(error, nowIso, ...binds),
  ];
}

/**
 * Best-effort removal of one attempt's outputs. Only ever keys DERIVED from the
 * row's own output prefix — never a key a request named.
 */
async function sweepAttempt(
  env: Env,
  outputPrefix: string,
  attempt: number,
): Promise<void> {
  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined || attempt < 1) {
    return;
  }

  const keys = attemptOutputKeys(outputPrefix, attempt);
  await Promise.all([
    bucket.delete(keys.printKey).catch(() => undefined),
    bucket.delete(keys.previewKey).catch(() => undefined),
  ]);
}

// ── acquire ─────────────────────────────────────────────────────────────────

/**
 * What the farm receives: the contract-v0 envelope it already validates, plus
 * the lease. `output.*PutUrl` are presigned for `{outputPrefix}print.png` and
 * `{outputPrefix}preview.webp`.
 */
export interface RenderJobLease extends JobEnvelope {
  attempt: number;
  leaseToken: string;
  leaseUntil: string;
  outputPrefix: string;
}

/**
 * Lease the oldest acquirable job, or null when there is none.
 *
 * ONE batch, so it is atomic and — D1 being single-writer per database — two
 * concurrent acquires can never lease the same job:
 *   1–4. expired leases already on their LAST attempt are ended (failed +
 *        alert); a fourth attempt is never started;
 *   5.   the oldest 'queued' job, or 'leased' job whose lease has expired, is
 *        leased with attempt+1 and a fresh token.
 */
export async function acquireRenderJob(
  env: Env,
  db: D1Database,
  now: number,
): Promise<RenderJobLease | null> {
  const nowIso = iso(now);
  const leaseUntil = iso(now + RENDER_JOB_LEASE_MS);
  const leaseToken = randomToken();
  const tokenHash = await sha256Hex(leaseToken);

  const reapWhere = `state = 'leased' AND lease_until < ? AND attempt >= ${RENDER_JOB_MAX_ATTEMPTS}`;

  const results = await db.batch([
    ...terminalFailureStatements(db, reapWhere, [nowIso], "lease_expired", now),
    db
      .prepare(
        `UPDATE render_jobs
         SET state = 'leased',
             attempt = attempt + 1,
             lease_token_hash = ?,
             lease_until = ?,
             error = CASE WHEN state = 'leased' THEN 'lease_expired' ELSE error END,
             updated_at = ?
         WHERE id = (
           SELECT id FROM render_jobs
           WHERE state = 'queued' OR (state = 'leased' AND lease_until < ?)
           ORDER BY created_at, id
           LIMIT 1
         )
         RETURNING ${JOB_COLUMNS}`,
      )
      .bind(tokenHash, leaseUntil, nowIso, nowIso),
  ]);

  const reaped = (results[3]?.results ?? []) as Array<{
    attempt: number;
    output_prefix: string;
  }>;
  await Promise.all(
    reaped.map((job) => sweepAttempt(env, job.output_prefix, job.attempt)),
  );

  const job = (results[4]?.results ?? [])[0] as RenderJobRow | undefined;
  if (job === undefined) {
    return null;
  }

  // The previous attempt is dead either way (it failed and was swept, or its
  // lease ran out). Clearing its prefix now keeps orphans from accumulating
  // when a stalled farm never reports; a late PUT it makes afterwards is swept
  // when its late report arrives.
  if (job.attempt > 1) {
    await sweepAttempt(env, job.output_prefix, job.attempt - 1);
  }

  const keys = attemptOutputKeys(job.output_prefix, job.attempt);
  const presigner = resolveR2Presigner(env);
  const [sourceUrl, printPutUrl, previewPutUrl] = await Promise.all([
    presigner.presignGet(job.input_key, RENDER_INPUT_URL_TTL_SECONDS),
    presigner.presignPut(keys.printKey, PRINT_CONTENT_TYPE),
    presigner.presignPut(keys.previewKey, PREVIEW_CONTENT_TYPE),
  ]);

  return {
    ...buildJobEnvelope({
      jobId: job.id,
      originalSizeBytes: job.input_bytes,
      previewPutUrl,
      printPutUrl,
      profile: JSON.parse(job.profile_json) as JobProfile,
      sourceUrl,
    }),
    attempt: job.attempt,
    leaseToken,
    leaseUntil,
    outputPrefix: keys.prefix,
  };
}

// ── reports: shared parsing and fencing ─────────────────────────────────────
// CP6-PS2: parseLeaseClaim, parseMetrics, promote and ERROR_CODE_PATTERN are
// exported, unchanged, for the print canvas jobs (src/pod/print-canvas-jobs.ts),
// which lease, report and promote exactly as these jobs do.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LeaseClaim {
  attempt: number;
  leaseToken: string;
}

export function parseLeaseClaim(
  body: unknown,
  allowedKeys: readonly string[],
): LeaseClaim | null {
  if (
    !isPlainObject(body) ||
    !Object.keys(body).every((key) => allowedKeys.includes(key))
  ) {
    return null;
  }

  const { attempt, leaseToken } = body;
  if (
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > RENDER_JOB_MAX_ATTEMPTS ||
    typeof leaseToken !== "string" ||
    !LEASE_TOKEN_PATTERN.test(leaseToken)
  ) {
    return null;
  }

  return { attempt, leaseToken };
}

function isFresh(
  job: RenderJobRow,
  claim: LeaseClaim,
  tokenHash: string,
  nowIso: string,
): boolean {
  return (
    job.state === "leased" &&
    claim.attempt === job.attempt &&
    job.lease_token_hash === tokenHash &&
    job.lease_until !== null &&
    job.lease_until > nowIso
  );
}

function isCompletedBy(
  job: RenderJobRow,
  claim: LeaseClaim,
  tokenHash: string,
): boolean {
  return (
    job.state === "completed" &&
    claim.attempt === job.attempt &&
    job.lease_token_hash === tokenHash
  );
}

/**
 * Whether a refused report's attempt is certainly dead, so its outputs may be
 * swept. An OLDER attempt always is. The CURRENT attempt only when the report
 * carries that attempt's own token (its holder, reporting late or after the job
 * ended) — a wrong token must never delete bytes a live holder is writing.
 */
function isDeadAttempt(
  job: RenderJobRow,
  claim: LeaseClaim,
  tokenHash: string,
): boolean {
  if (claim.attempt < job.attempt) {
    return true;
  }

  return (
    claim.attempt === job.attempt &&
    job.lease_token_hash === tokenHash &&
    job.state !== "completed"
  );
}

async function refuseStale(
  env: Env,
  job: RenderJobRow,
  claim: LeaseClaim,
  tokenHash: string,
): Promise<{ status: "stale" }> {
  if (isDeadAttempt(job, claim, tokenHash)) {
    await sweepAttempt(env, job.output_prefix, claim.attempt);
  }
  return { status: "stale" };
}

/**
 * After a fenced write matched nothing: either a duplicate of this very report
 * completed the job first (an idempotent replay — answer as it did), or the
 * lease was lost. No sweep here: a concurrent duplicate may be reading the
 * attempt objects right now.
 */
async function staleOrCompleted(
  db: D1Database,
  jobId: string,
  claim: LeaseClaim,
  tokenHash: string,
): Promise<{ status: "completed" | "stale" }> {
  const job = await loadJob(db, jobId);
  return job !== null && isCompletedBy(job, claim, tokenHash)
    ? { status: "completed" }
    : { status: "stale" };
}

/**
 * One attempt did not produce a usable result: back to 'queued' while attempts
 * remain, otherwise the job ends. Fenced, and the attempt's outputs are swept.
 */
async function recordAttemptFailure(
  env: Env,
  db: D1Database,
  job: RenderJobRow,
  claim: LeaseClaim,
  tokenHash: string,
  error: string,
): Promise<"failed" | "queued" | "stale"> {
  const nowMs = Date.now();
  const binds = fenceBinds(job.id, claim.attempt, tokenHash, nowMs);

  if (claim.attempt < RENDER_JOB_MAX_ATTEMPTS) {
    const requeued = await db
      .prepare(
        `UPDATE render_jobs
         SET state = 'queued', lease_token_hash = NULL, lease_until = NULL,
             error = ?, updated_at = ?
         WHERE ${FENCE}`,
      )
      .bind(error, iso(nowMs), ...binds)
      .run();
    if ((requeued.meta.changes ?? 0) === 0) {
      return "stale";
    }
    await sweepAttempt(env, job.output_prefix, claim.attempt);
    return "queued";
  }

  const results = await db.batch(
    terminalFailureStatements(db, FENCE, binds, error, nowMs),
  );
  if ((results[3]?.meta.changes ?? 0) === 0) {
    return "stale";
  }
  await sweepAttempt(env, job.output_prefix, claim.attempt);
  return "failed";
}

// ── fail ────────────────────────────────────────────────────────────────────

export type FailRenderJobResult = {
  status: "failed" | "invalid" | "not_found" | "queued" | "stale";
};

const FAIL_KEYS = ["attempt", "error", "leaseToken"] as const;

/**
 * `{ attempt, leaseToken, error }` — the farm could not produce a result (input
 * fetch failed, pipeline crash, output PUT failed). The error is a CODE; the
 * detail lives in the farm's logs keyed by job id.
 */
export async function failRenderJob(
  env: Env,
  db: D1Database,
  jobId: string,
  body: unknown,
  now: number,
): Promise<FailRenderJobResult> {
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

  return {
    status: await recordAttemptFailure(env, db, job, claim, tokenHash, error),
  };
}

// ── complete ────────────────────────────────────────────────────────────────

export type CompleteRenderJobResult = {
  status:
    | "canonical_conflict"
    | "completed"
    | "invalid"
    | "not_found"
    | "outputs_unverified"
    | "stale";
};

const COMPLETE_KEYS = [
  "attempt",
  "fields",
  "leaseToken",
  "metrics",
  "notices",
  "ok",
  "outputs",
  "reasons",
] as const;

type CompletionReport =
  | { reasons: JobNotice[]; status: "rejected" }
  | {
      meta: JobMeta;
      notices: JobNotice[];
      outputs: { previewWebp: JobOutputReport; printPng: JobOutputReport };
      status: "ok";
    };

/**
 * The verdict half of a completion. The farm's own body is parsed by the SAME
 * parser the synchronous dispatch uses (parseFarmResult); on success the two
 * reported keys must be exactly this attempt's keys — a completion cannot point
 * the promotion at any other object.
 */
function parseCompletionReport(
  body: Record<string, unknown>,
  expected: { previewKey: string; printKey: string },
): CompletionReport | null {
  const result = parseFarmResult(body);
  if (result.status === "failed") {
    return null;
  }
  if (result.status === "rejected") {
    return result;
  }

  const outputs = body.outputs as Record<string, Record<string, unknown>>;
  if (
    outputs.printPng?.key !== expected.printKey ||
    outputs.previewWebp?.key !== expected.previewKey
  ) {
    return null;
  }

  return result;
}

export function parseMetrics(value: unknown): Record<string, number> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value);
  if (
    entries.length > MAX_METRICS ||
    !entries.every(
      ([key, metric]) =>
        METRIC_KEY_PATTERN.test(key) &&
        typeof metric === "number" &&
        Number.isFinite(metric),
    )
  ) {
    return null;
  }

  return value as Record<string, number>;
}

export type PromotionOutcome = "conflict" | "present" | "promoted" | "unverified";

/**
 * Copy one verified attempt object to its canonical key.
 *
 * Canonical keys are IMMUTABLE: an object already there with the same sha256
 * and size is this output (a duplicate completion, or a promotion whose commit
 * lost the fence) and is left as it is; anything else there is a conflict and
 * is never overwritten.
 *
 * The copy streams through the binding (R2 has no server-side copy on the
 * binding) and passes the farm's reported sha256 to `put`, so R2 ITSELF
 * verifies the bytes it stores against the hash the farm claimed: a mismatch
 * is rejected by R2 (10037) and nothing is written. The synchronous path could
 * only compare sizes; promotion verifies the content for free.
 *
 * THE WRITE IS CREATE-IF-ABSENT (`If-None-Match: *`), not a check-then-write.
 * The head() below is only a shortcut; between it and the put a promotion can
 * stall — past its lease, while a NEWER attempt is leased, completes and writes
 * the canonical object. An unconditional put would then overwrite the newer
 * attempt's bytes, and the D1 fence that later refuses the stale commit could
 * not undo that. With the precondition R2 refuses the write (put() → null) and
 * the object that won is re-verified instead: the same sha256 and size is this
 * output, anything else is a conflict. The form is the documented one — "a
 * Headers object containing conditional headers … all conditional headers
 * aside from If-Range are supported", put() returning null when the condition
 * fails (R2 Workers API reference) — and was verified under miniflare in
 * test/render-jobs.test.ts; R2 itself proves it on the staging smoke.
 */
function sameOutput(object: R2Object, report: JobOutputReport): boolean {
  return (
    object.checksums.toJSON().sha256 === report.sha256 &&
    object.size === report.bytes
  );
}

export async function promote(
  bucket: R2Bucket,
  fromKey: string,
  toKey: string,
  report: JobOutputReport,
  contentType: string,
): Promise<PromotionOutcome> {
  const existing = await bucket.head(toKey);
  if (existing !== null) {
    return sameOutput(existing, report) ? "present" : "conflict";
  }

  const source = await bucket.get(fromKey);
  if (source === null) {
    return "unverified";
  }
  if (source.size !== report.bytes) {
    await source.body.cancel();
    return "unverified";
  }

  let written: R2Object | null;
  try {
    written = await bucket.put(toKey, source.body, {
      httpMetadata: { contentType },
      onlyIf: new Headers({ "If-None-Match": "*" }),
      sha256: report.sha256,
    });
  } catch {
    return "unverified";
  }

  if (written === null) {
    // Someone created the canonical object after the head() above. Never
    // overwrite it: re-verify it.
    const winner = await bucket.head(toKey);
    return winner !== null && sameOutput(winner, report) ? "present" : "conflict";
  }

  return "promoted";
}

/**
 * `POST /v1/render/jobs/{id}/complete`.
 *
 *   fenced? ─ no ─→ replay of the accepted completion → "completed"
 *                   anything else → "stale" (+ sweep of a dead attempt)
 *     │ yes
 *   body valid? ─ no → "invalid" (lease untouched; the farm may resend)
 *     │
 *   fence + extend the lease for the promotion window
 *     │
 *   ok:false → job completed, artwork 'rejected' with the reasons
 *   ok:true  → HEAD both attempt objects (sizes) → promote both (sha256
 *              verified by R2) → job completed + artwork 'ready' + audit in ONE
 *              batch, fenced again at commit time.
 *   unverified outputs → the attempt failed (requeue / fail after 3)
 *   canonical conflict → the job fails now (alert): retrying cannot fix it
 */
export async function completeRenderJob(
  env: Env,
  db: D1Database,
  jobId: string,
  body: unknown,
  now: number,
): Promise<CompleteRenderJobResult> {
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
  if (isCompletedBy(job, claim, tokenHash)) {
    return { status: "completed" };
  }
  if (!isFresh(job, claim, tokenHash, iso(now))) {
    return refuseStale(env, job, claim, tokenHash);
  }

  const expected = attemptOutputKeys(job.output_prefix, claim.attempt);
  const report = parseCompletionReport(record, expected);
  const metrics = parseMetrics(record.metrics);
  if (report === null || metrics === null) {
    return { status: "invalid" };
  }

  // Fence and extend: from here until the commit no other attempt can be
  // leased, so nothing else can write the canonical keys.
  const extended = await db
    .prepare(
      `UPDATE render_jobs
       SET lease_until = MAX(lease_until, ?), updated_at = ?
       WHERE ${FENCE}`,
    )
    .bind(
      iso(now + RENDER_JOB_PROMOTION_MS),
      iso(now),
      ...fenceBinds(job.id, claim.attempt, tokenHash, now),
    )
    .run();
  if ((extended.meta.changes ?? 0) === 0) {
    return staleOrCompleted(db, job.id, claim, tokenHash);
  }

  if (metrics !== undefined) {
    // For the render-host benchmark (DECISIONS D6): numbers only, keyed by job.
    console.log(
      JSON.stringify({
        attempt: claim.attempt,
        jobId: job.id,
        message: "render job metrics",
        metrics,
      }),
    );
  }

  const profileId = (JSON.parse(job.profile_json) as JobProfile).id;

  if (report.status === "rejected") {
    return commitVerdict(env, db, job, claim, tokenHash, {
      action: "pod.artwork.rejected",
      artworkUpdate: {
        binds: [JSON.stringify(report.reasons)],
        set: `status = 'rejected', reasons_json = ?`,
      },
      metadata: {
        profileId,
        reasonCodes: report.reasons.map((reason) => reason.code),
      },
    });
  }

  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined) {
    // Unreachable behind isRenderJobsConfigured; fail loudly if a caller skips it.
    throw new Error("render jobs surface is not configured");
  }

  const [printHead, previewHead] = await Promise.all([
    bucket.head(expected.printKey),
    bucket.head(expected.previewKey),
  ]);
  if (
    printHead === null ||
    previewHead === null ||
    printHead.size !== report.outputs.printPng.bytes ||
    previewHead.size !== report.outputs.previewWebp.bytes
  ) {
    return attemptFailedResult(
      await recordAttemptFailure(env, db, job, claim, tokenHash, "outputs_unverified"),
      db,
      job.id,
      claim,
      tokenHash,
    );
  }

  const canonical = canonicalOutputKeys(job.tenant_id, job.artwork_id);
  const promotions: PromotionOutcome[] = [];
  for (const [from, to, output, contentType] of [
    [expected.printKey, canonical.printKey, report.outputs.printPng, PRINT_CONTENT_TYPE],
    [expected.previewKey, canonical.previewKey, report.outputs.previewWebp, PREVIEW_CONTENT_TYPE],
  ] as const) {
    const outcome = await promote(bucket, from, to, output, contentType);
    promotions.push(outcome);
    if (outcome === "conflict" || outcome === "unverified") {
      break;
    }
  }

  if (promotions.includes("conflict")) {
    const nowMs = Date.now();
    const results = await db.batch(
      terminalFailureStatements(
        db,
        FENCE,
        fenceBinds(job.id, claim.attempt, tokenHash, nowMs),
        "canonical_conflict",
        nowMs,
      ),
    );
    if ((results[3]?.meta.changes ?? 0) === 0) {
      return staleOrCompleted(db, job.id, claim, tokenHash);
    }
    await sweepAttempt(env, job.output_prefix, claim.attempt);
    return { status: "canonical_conflict" };
  }

  if (promotions.includes("unverified")) {
    return attemptFailedResult(
      await recordAttemptFailure(env, db, job, claim, tokenHash, "outputs_unverified"),
      db,
      job.id,
      claim,
      tokenHash,
    );
  }

  const { meta, notices, outputs } = report;
  return commitVerdict(env, db, job, claim, tokenHash, {
    action: "pod.artwork.ready",
    artworkUpdate: {
      binds: [
        meta.widthPx,
        meta.heightPx,
        meta.effectiveDpi,
        meta.maxPrintMm.w,
        meta.maxPrintMm.h,
        meta.pipelineVersion,
        JSON.stringify(notices),
        canonical.printKey,
        canonical.previewKey,
        outputs.printPng.sha256,
        outputs.printPng.bytes,
        outputs.previewWebp.sha256,
        outputs.previewWebp.bytes,
      ],
      set: `status = 'ready',
            width_px = ?, height_px = ?, effective_dpi = ?,
            max_print_w_mm = ?, max_print_h_mm = ?, pipeline_version = ?,
            notices_json = ?,
            print_object_key = ?, preview_object_key = ?,
            print_sha256 = ?, print_bytes = ?,
            preview_sha256 = ?, preview_bytes = ?`,
    },
    metadata: {
      effectiveDpi: meta.effectiveDpi,
      noticeCodes: notices.map((notice) => notice.code),
      profileId,
    },
  });
}

async function attemptFailedResult(
  outcome: "failed" | "queued" | "stale",
  db: D1Database,
  jobId: string,
  claim: LeaseClaim,
  tokenHash: string,
): Promise<CompleteRenderJobResult> {
  return outcome === "stale"
    ? staleOrCompleted(db, jobId, claim, tokenHash)
    : { status: "outputs_unverified" };
}

/**
 * The completion's audit event id — DETERMINISTIC, one per job. Two completion
 * requests for the same attempt (a farm resending after a lost response) can
 * both pass the fence-and-extend and both reach the commit; the second batch's
 * job UPDATE changes nothing, but "this attempt completed the job" is true for
 * it as well, so a random id would audit the verdict twice. With a fixed id and
 * ON CONFLICT DO NOTHING the second insert is a no-op. A job completes at most
 * once (the terminal trigger), so the job id alone is the right key.
 */
export function completionAuditEventId(jobId: string): string {
  return `render-job-completed:${jobId}`;
}

/**
 * The commit: job → 'completed', the artwork's verdict, and its audit row, in
 * ONE batch. The job update is fenced at commit time; the artwork update and
 * the audit insert are conditioned on "this attempt completed the job", so if
 * the fence fails the batch changes nothing at all — and the audit insert is
 * also idempotent by id (completionAuditEventId), so an overlapping duplicate
 * completion cannot write a second row.
 *
 * The artwork update keeps the synchronous path's `status = 'processing'`
 * guard: a verdict that somehow already exists stands and is not overwritten.
 */
async function commitVerdict(
  env: Env,
  db: D1Database,
  job: RenderJobRow,
  claim: LeaseClaim,
  tokenHash: string,
  verdict: {
    action: "pod.artwork.ready" | "pod.artwork.rejected";
    artworkUpdate: { binds: unknown[]; set: string };
    metadata: Record<string, unknown>;
  },
): Promise<CompleteRenderJobResult> {
  const nowMs = Date.now();
  const nowIso = iso(nowMs);
  const completedByThisAttempt = `EXISTS (
    SELECT 1 FROM render_jobs
    WHERE id = ? AND state = 'completed' AND attempt = ? AND lease_token_hash = ?
  )`;
  const mine = [job.id, claim.attempt, tokenHash];

  const results = await db.batch([
    db
      .prepare(
        `UPDATE render_jobs
         SET state = 'completed', completed_at = ?, updated_at = ?
         WHERE ${FENCE}`,
      )
      .bind(nowIso, nowIso, ...fenceBinds(job.id, claim.attempt, tokenHash, nowMs)),
    db
      .prepare(
        `UPDATE pod_artwork
         SET ${verdict.artworkUpdate.set}, updated_at = ?
         WHERE tenant_id = ? AND artwork_id = ? AND status = 'processing'
           AND ${completedByThisAttempt}`,
      )
      .bind(
        ...verdict.artworkUpdate.binds,
        nowMs,
        job.tenant_id,
        job.artwork_id,
        ...mine,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type,
           resource_id, request_id, metadata_json, created_at
         )
         SELECT ?, ?, NULL, ?, 'pod_artwork', ?, ?, ?, ?
         WHERE ${completedByThisAttempt}
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(
        completionAuditEventId(job.id),
        job.tenant_id,
        verdict.action,
        job.artwork_id,
        crypto.randomUUID(),
        JSON.stringify({
          ...verdict.metadata,
          attempt: claim.attempt,
          renderJobId: job.id,
        }),
        nowMs,
        ...mine,
      ),
  ]);

  if ((results[0]?.meta.changes ?? 0) === 0) {
    return staleOrCompleted(db, job.id, claim, tokenHash);
  }

  // The attempt objects were copied to the canonical keys (or there were none,
  // for a rejection); the attempt prefix is garbage now.
  await sweepAttempt(env, job.output_prefix, claim.attempt);
  return { status: "completed" };
}
