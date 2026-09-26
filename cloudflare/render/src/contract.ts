/**
 * The wire contract between this container and the API's pull surface
 * (cloudflare/src/routes/render-jobs.ts, cloudflare/src/pod/render-jobs.ts):
 *
 *   POST /v1/render/jobs/acquire        → 204 | 200 lease + contract-v0 envelope
 *   POST /v1/render/jobs/{id}/complete  → { attempt, leaseToken, ok, fields, notices, outputs, metrics }
 *                                         | { attempt, leaseToken, ok: false, reasons, metrics }
 *   POST /v1/render/jobs/{id}/fail      → { attempt, leaseToken, error: "<code>" }
 *
 * PURE ON PURPOSE: no Node API, no import. The Worker's own test suite imports this
 * file (cloudflare/test/render-container.test.ts) and drives the REAL routes with
 * the bodies built here, so a drift between the two deploy units is a failing test
 * rather than a 400 in production.
 *
 * The envelope checks are the old farm's validator, ported (same fields, same
 * bounds, same host allowlist), tightened in two places: `jobId` must be the UUID
 * the API mints (it is interpolated into the report URL), and the lease fields
 * are validated as the API issues them.
 */

export const CONTRACT_VERSION = 1;
export const JOB_TYPE = "pod.process_artwork";

/**
 * The container's own ceiling on the input download, whatever the job asks for:
 * the farm's HARD_MAX_INPUT_BYTES, unchanged (and the value the API clamps
 * `input.maxBytes` to, render-farm-client.ts FARM_MAX_INPUT_BYTES).
 */
export const HARD_MAX_INPUT_BYTES = 200 * 1024 * 1024;

/**
 * Every URL the container dereferences for a job (the input GET and both output
 * PUTs) must be https on an R2 S3 host. A job URL is capability-bearing input; an
 * unchecked PUT target would be an exfiltration primitive. Suffix match on the
 * PARSED hostname — `https://evil.test/?x=.r2.cloudflarestorage.com` and
 * `http://169.254.169.254/` both fail. The EU-jurisdiction host
 * (`{account}.eu.r2.cloudflarestorage.com`) ends in the same suffix.
 */
export const ALLOWED_STORAGE_HOST_SUFFIX = ".r2.cloudflarestorage.com";

/** RENDER_JOB_MAX_ATTEMPTS in the API. */
export const MAX_ATTEMPTS = 3;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const METRIC_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_METRICS = 20;
const MAX_OUTPUT_PREFIX_LENGTH = 512;

/** The five profile fields the pipeline consumes (render-farm-client.ts JobProfile). */
export interface JobProfile {
  accepted_formats?: Array<{ ext: string }>;
  id: string;
  max_file_mb?: number;
  min_dpi: number;
  print_area_mm: { h: number; w: number };
}

/** What a report must carry to be heard at all. */
export interface LeaseClaim {
  attempt: number;
  jobId: string;
  leaseToken: string;
}

export interface RenderLease extends LeaseClaim {
  inputMaxBytes: number;
  inputUrl: string;
  leaseUntil: string;
  outputPrefix: string;
  previewPutUrl: string;
  printPutUrl: string;
  profile: JobProfile;
}

/**
 * A lease whose ENVELOPE is malformed but whose claim fields are intact can still
 * be reported as failed (so the job requeues now instead of waiting out the lease);
 * one without even a claim is dropped and left to the lease expiry.
 */
export type ParsedLease =
  | { lease: RenderLease; ok: true }
  | { claim: LeaseClaim | null; ok: false };

export interface Notice {
  code: string;
  message: string;
}

/** The measured facts (the API's JobMeta; the farm's PipelineMeta). */
export interface PipelineMeta {
  effectiveDpi: number;
  heightPx: number;
  maxPrintMm: { h: number; w: number };
  pipelineVersion: number;
  profileId: string;
  widthPx: number;
}

export interface OutputReport {
  bytes: number;
  sha256: string;
}

/**
 * The fail codes this container sends. The API stores the code on the job row and
 * requires `[A-Za-z0-9_.:-]{1,100}`; detail lives in the container's log.
 */
export type FailureCode =
  | "completion_invalid"
  | "input_fetch_failed"
  | "input_too_large"
  | "invalid_envelope"
  | "output_put_failed"
  | "pipeline_crashed";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isAllowedStorageUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") {
    return false;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.hostname.toLowerCase().endsWith(ALLOWED_STORAGE_HOST_SUFFIX)
  );
}

/** The farm's isValidProfile, ported. */
export function parseProfile(value: unknown): JobProfile | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const { accepted_formats, id, max_file_mb, min_dpi, print_area_mm } = value;
  if (
    !isNonEmptyString(id) ||
    !isPositiveSafeInt(min_dpi) ||
    !isPlainObject(print_area_mm) ||
    !isPositiveFinite(print_area_mm.w) ||
    !isPositiveFinite(print_area_mm.h)
  ) {
    return null;
  }
  // Optional in the pipeline (absent disables the size gate), but when present a
  // real positive number.
  if (max_file_mb !== undefined && !isPositiveFinite(max_file_mb)) {
    return null;
  }
  // Optional too; when present every entry needs a string ext, because a garbage
  // list would reject every file with a nonsense "Tillåtna format:" message
  // instead of failing the job honestly.
  let formats: Array<{ ext: string }> | undefined;
  if (accepted_formats !== undefined) {
    if (
      !Array.isArray(accepted_formats) ||
      !accepted_formats.every(
        (entry) => isPlainObject(entry) && isNonEmptyString(entry.ext),
      )
    ) {
      return null;
    }
    formats = accepted_formats.map((entry) => ({
      ext: (entry as { ext: string }).ext,
    }));
  }

  return {
    ...(formats === undefined ? {} : { accepted_formats: formats }),
    id,
    ...(max_file_mb === undefined ? {} : { max_file_mb }),
    min_dpi,
    print_area_mm: { h: print_area_mm.h, w: print_area_mm.w },
  };
}

function parseClaim(body: Record<string, unknown>): LeaseClaim | null {
  const { attempt, jobId, leaseToken } = body;
  if (
    typeof jobId !== "string" ||
    !UUID_PATTERN.test(jobId) ||
    typeof attempt !== "number" ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > MAX_ATTEMPTS ||
    typeof leaseToken !== "string" ||
    !LEASE_TOKEN_PATTERN.test(leaseToken)
  ) {
    return null;
  }
  return { attempt, jobId, leaseToken };
}

/** The 200 body of acquire: the contract-v0 envelope plus the lease. */
export function parseLease(body: unknown): ParsedLease {
  if (!isPlainObject(body)) {
    return { claim: null, ok: false };
  }
  const claim = parseClaim(body);
  if (claim === null) {
    return { claim: null, ok: false };
  }

  const { contract, input, jobType, leaseUntil, output, outputPrefix } = body;
  const profile = parseProfile(body.profile);
  if (
    contract !== CONTRACT_VERSION ||
    jobType !== JOB_TYPE ||
    !isPlainObject(input) ||
    !isAllowedStorageUrl(input.url) ||
    !isPositiveSafeInt(input.maxBytes) ||
    profile === null ||
    !isPlainObject(output) ||
    !isAllowedStorageUrl(output.printPngPutUrl) ||
    !isAllowedStorageUrl(output.previewWebpPutUrl) ||
    typeof leaseUntil !== "string" ||
    !Number.isFinite(Date.parse(leaseUntil)) ||
    typeof outputPrefix !== "string" ||
    outputPrefix.length === 0 ||
    outputPrefix.length > MAX_OUTPUT_PREFIX_LENGTH ||
    !outputPrefix.endsWith("/")
  ) {
    return { claim, ok: false };
  }

  return {
    lease: {
      ...claim,
      inputMaxBytes: input.maxBytes,
      inputUrl: input.url,
      leaseUntil,
      outputPrefix,
      previewPutUrl: output.previewWebpPutUrl,
      printPutUrl: output.printPngPutUrl,
      profile,
    },
    ok: true,
  };
}

/**
 * The keys a success report names. The API compares them with ITS attempt keys
 * (`{outputPrefix}print.png`, `{outputPrefix}preview.webp`) and answers 400 on any
 * difference, so they are derived from the lease and never from the PUT URLs.
 */
export function outputKeys(outputPrefix: string): {
  previewKey: string;
  printKey: string;
} {
  return {
    previewKey: `${outputPrefix}preview.webp`,
    printKey: `${outputPrefix}print.png`,
  };
}

/**
 * Numbers only, at most 20, keys the API accepts — anything else is dropped here
 * rather than turning a good completion into a 400 over a diagnostic.
 */
export function sanitizeMetrics(metrics: Record<string, number>): Record<string, number> {
  const kept: Record<string, number> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (Object.keys(kept).length >= MAX_METRICS) {
      break;
    }
    if (METRIC_KEY_PATTERN.test(key) && Number.isFinite(value)) {
      kept[key] = value;
    }
  }
  return kept;
}

export type Verdict =
  | {
      meta: PipelineMeta;
      notices: Notice[];
      ok: true;
      outputs: { previewWebp: OutputReport; printPng: OutputReport };
    }
  | { ok: false; reasons: Notice[] };

/** The complete body, exactly the keys completeRenderJob accepts. */
export function completionBody(
  lease: RenderLease,
  verdict: Verdict,
  metrics: Record<string, number>,
): Record<string, unknown> {
  const claim = { attempt: lease.attempt, leaseToken: lease.leaseToken };
  const cleanMetrics = sanitizeMetrics(metrics);

  if (!verdict.ok) {
    return { ...claim, metrics: cleanMetrics, ok: false, reasons: verdict.reasons };
  }

  const keys = outputKeys(lease.outputPrefix);
  return {
    ...claim,
    fields: verdict.meta,
    metrics: cleanMetrics,
    notices: verdict.notices,
    ok: true,
    outputs: {
      previewWebp: { key: keys.previewKey, ...verdict.outputs.previewWebp },
      printPng: { key: keys.printKey, ...verdict.outputs.printPng },
    },
  };
}

export function failureBody(
  claim: LeaseClaim,
  error: FailureCode,
): { attempt: number; error: FailureCode; leaseToken: string } {
  return { attempt: claim.attempt, error, leaseToken: claim.leaseToken };
}

export function reportPath(jobId: string, action: "complete" | "fail"): string {
  return `/v1/render/jobs/${jobId}/${action}`;
}

export const ACQUIRE_PATH = "/v1/render/jobs/acquire";
