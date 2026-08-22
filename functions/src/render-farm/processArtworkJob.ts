// processArtworkJob — the RENDER FARM's `pod.process_artwork` job endpoint.
//
// SSOT: docs/RENDER_FARM_CONTRACT.md (v0). Built DARK at checkpoint 26: nothing
// calls it until the Cloudflare POD checkpoint lands the Worker side, and while
// RENDER_FARM_TOKEN is unset it is indistinguishable from a route that was never
// written (see "fail closed" below).
//
// ── WHY onRequest, NOT onCall ────────────────────────────────────────────────
// The caller is a Cloudflare Worker, not a browser: there is no Firebase client
// SDK, no App Check attestation and no Firebase Auth ID token anywhere in this
// path. `onCall`'s entire value is that protocol envelope plus automatic auth
// context, all of which would be dead weight (and a second, weaker auth story)
// for a server-to-server call authenticated by a shared secret. Plain HTTPS with
// a Bearer token is the whole contract. For the same reason there is NO cors
// option: no browser ever reaches this, so a preflight is not a scenario, and
// declaring an origin allowlist would only imply one exists.
//
// ── WHY THE FARM KNOWS NOTHING ABOUT TENANTS ────────────────────────────────
// Principle 1 of the contract. The job is self-contained: the bytes come from a
// presigned GET URL, the profile rides inline in the payload, and the outputs go
// back through presigned PUT URLs. No Firestore, no Firebase Auth, no shopId, no
// storage paths with meaning. The WORKER owns all authorization (admin-of-shop,
// path prefixes, quotas) before a job is ever created — mirroring today's split
// where `processPodArtwork`'s guards wrap the pure core. The farm's only auth
// question is "is the caller the platform?", and one shared secret answers it.
// A consequence worth stating: a valid token grants the ability to run sharp on
// bytes the caller already holds URLs for. It grants nothing else, because there
// is nothing else here to grant.
//
// ── WHY THE RESPONSES ARE CONSTANT ──────────────────────────────────────────
// Every failure that is not a pipeline VERDICT answers with a fixed body and no
// detail: 404 (unconfigured / not POST), 401 (bad or missing token), 400
// (malformed envelope), 502 (input fetch, output PUT, or a pipeline crash).
// Nothing echoes back which field was wrong, which host was rejected, or what
// the upstream said — an unauthenticated prober learns only that something is
// listening, and even that only once the token exists. Detail goes to the
// function logs keyed by jobId, where the platform operator can read it and a
// caller cannot. This mirrors the Cloudflare worker's own posture on its
// webhook/platform surfaces, where the unconfigured gate runs before the method
// check and before the body is read so that an unconfigured deployment looks
// exactly like one where the route does not exist
// (cloudflare/src/index.ts — isStripeWebhookConfigured / notFoundResponse).
//
// ── GATE REJECTIONS ARE RESULTS, NOT ERRORS ─────────────────────────────────
// A file that fails the 300-DPI gate answers 200 `{ ok:false, reasons }` with
// the Swedish user-facing messages unchanged from prod. The job ran correctly;
// the artwork is what failed. Only job-level faults get a non-2xx.
//
// ── TOKEN ROTATION (v0) ─────────────────────────────────────────────────────
// ONE token, `RENDER_FARM_TOKEN`. Rotating it means a brief window where the
// Worker and the farm disagree, i.e. every job 401s until both sides are set.
// The contract anticipates the farm accepting TWO tokens during a rotation
// window; that is deliberately NOT built at v0, because a second accepted
// secret is a second thing to leak and there is no traffic yet to protect.
// When rotation matters, add `RENDER_FARM_TOKEN_NEXT` and check it as a second
// timing-safe comparison here — nothing else in this file needs to change.
//
// ── THE PORTABILITY POINT ───────────────────────────────────────────────────
// THIS FILE PLUS `pod/artworkPipelineCore.ts` IS THE ENTIRE FARM for artwork.
// A future Cloudflare Container would reimplement exactly this pair — the same
// envelope, the same allowlist, the same response shapes, calling the same pure
// pipeline — and the Worker would not know the difference. That is the whole
// reason the contract exists rather than the Worker calling sharp directly.
import { onRequest, type HttpsOptions } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { createHash, timingSafeEqual } from 'crypto';
import { runArtworkPipeline, type PipelineProfile } from '../pod/artworkPipelineCore';

// 2GiB / 300 s / us-central1 — carried over VERBATIM from the callable's OPTS.
// The 2026-07-27 OOM lessons are encoded in the memory figure (1GiB died on
// 7087px files) and `sharp.cache(false)` + `concurrency(1)` come with the core
// module's import side effect. No `cors`: server-to-server only, see header.
// (Not `as const`: firebase-functions' HttpsOptions wants a MUTABLE secrets
// array, matching how every other secret-bound function here declares it —
// e.g. payment/stripeWebhook.ts.)
const OPTS: HttpsOptions = {
  region: 'us-central1',
  memory: '2GiB',
  timeoutSeconds: 300,
  secrets: ['RENDER_FARM_TOKEN'],
};

// The platform's R2 endpoint allowlist. SSRF discipline carried over from the
// catalogue migrators: a presigned URL arrives from the caller, so the host is
// attacker-influenced input until it is checked against a fixed suffix list.
// Suffix match on the parsed hostname (never on the raw string) + https only —
// that combination is what stops `https://evil.com/?x=.r2.cloudflarestorage.com`
// and `http://169.254.169.254/`. Applies to the INPUT GET url and to BOTH output
// PUT urls: an unchecked PUT target is an exfiltration primitive, not just an
// SSRF one.
const ALLOWED_INPUT_HOST_SUFFIXES = ['.r2.cloudflarestorage.com'] as const;

// Absolute ceiling regardless of what the job asks for — the farm's own memory
// protection, independent of any caller's arithmetic.
const HARD_MAX_INPUT_BYTES = 200 * 1024 * 1024;

// A token shorter than this is treated as absent: a placeholder, a truncated
// paste or an empty-string secret must fail CLOSED (dark), never open a real
// endpoint behind a guessable credential.
const MIN_TOKEN_LENGTH = 16;

interface JobEnvelope {
  contract: number;
  jobType: string;
  jobId: string;
  input: { url: string; maxBytes: number };
  profile: PipelineProfile;
  output: { printPngPutUrl: string; previewWebpPutUrl: string };
}

/**
 * Mirrors the Cloudflare worker's `isStripeConfigured` / `isStripeWebhookConfigured`
 * pattern (cloudflare/src/index.ts): a secret that is absent, empty or obviously
 * not a real secret means the surface DOES NOT EXIST. The gate runs before the
 * method check and before the body is read, so an unconfigured deployment is
 * indistinguishable from one where this function was never deployed.
 */
const resolveToken = (): string | null => {
  const token = (process.env.RENDER_FARM_TOKEN || '').trim();
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
};

/**
 * Constant-time bearer comparison. `timingSafeEqual` THROWS on unequal lengths,
 * which would itself leak the secret's length through timing/behaviour — so both
 * sides are hashed to a fixed 32 bytes first and the digests are compared. The
 * length equalization is the hash, not a pad.
 */
const bearerMatches = (presented: string, expected: string): boolean => {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
};

const isString = (v: unknown): v is string => typeof v === 'string';
const isNonEmptyString = (v: unknown): v is string => isString(v) && v.length > 0;
const isPositiveSafeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Shape-validates the five profile fields the pure core consumes. */
const isValidProfile = (p: any): p is PipelineProfile => {
  if (!p || typeof p !== 'object') return false;
  if (!isNonEmptyString(p.id)) return false;
  if (!isPositiveSafeInt(p.min_dpi)) return false;
  const area = p.print_area_mm;
  if (!area || typeof area !== 'object') return false;
  if (typeof area.w !== 'number' || !Number.isFinite(area.w) || area.w <= 0) return false;
  if (typeof area.h !== 'number' || !Number.isFinite(area.h) || area.h <= 0) return false;
  // max_file_mb is optional in the core (0/absent disables the size gate), but
  // when present it must be a real positive number.
  if (p.max_file_mb !== undefined && (typeof p.max_file_mb !== 'number' || !Number.isFinite(p.max_file_mb) || p.max_file_mb <= 0)) return false;
  // accepted_formats is optional in the core; when present every entry needs a
  // string ext, because an empty/garbage list would reject every file with a
  // nonsense "Tillåtna format:" message rather than fail the job honestly.
  if (p.accepted_formats !== undefined) {
    if (!Array.isArray(p.accepted_formats)) return false;
    if (!p.accepted_formats.every((f: any) => f && typeof f === 'object' && isNonEmptyString(f.ext))) return false;
  }
  return true;
};

const isValidEnvelope = (body: any): body is JobEnvelope => {
  if (!body || typeof body !== 'object') return false;
  if (body.contract !== 1) return false;
  if (body.jobType !== 'pod.process_artwork') return false;
  if (!isNonEmptyString(body.jobId)) return false;
  if (!body.input || typeof body.input !== 'object') return false;
  if (!isString(body.input.url)) return false;
  if (!isPositiveSafeInt(body.input.maxBytes)) return false;
  if (!isValidProfile(body.profile)) return false;
  if (!body.output || typeof body.output !== 'object') return false;
  if (!isString(body.output.printPngPutUrl)) return false;
  if (!isString(body.output.previewWebpPutUrl)) return false;
  return true;
};

/** https + hostname suffix allowlist. Returns the parsed URL or null. */
const parseAllowedUrl = (raw: string): URL | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_INPUT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
  return url;
};

/**
 * Streams the input, aborting the moment the cap is exceeded — the bytes past
 * the cap are never buffered, and sharp never sees a byte of an oversized file.
 * A `content-length` that claims too much is refused before the first chunk, but
 * an absent or lying header changes nothing: the running total is the authority.
 * `redirect: 'error'` because a redirect would move the request to a host the
 * allowlist never approved.
 */
async function fetchInput(url: URL, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url, { method: 'GET', redirect: 'error' });
  if (!res.ok || !res.body) throw new Error(`input_fetch_status_${res.status}`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('input_too_large');

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => { /* the cap already decided the outcome */ });
      throw new Error('input_too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function putOutput(url: URL, body: Buffer, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
    headers: { 'content-type': contentType, 'content-length': String(body.length) },
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`output_put_status_${res.status}`);
}

const sha256Hex = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

export const renderFarmProcessArtwork = onRequest(OPTS, async (req, res) => {
  // ── 1. FAIL CLOSED DARK. Before the method check, before any body read. ──
  const token = resolveToken();
  if (!token) {
    res.status(404).json({ error: { code: 'not_found' } });
    return;
  }

  // ── 2. AUTH. Before the body is parsed, so an unauthenticated caller never
  //        reaches the validator, the allowlist or sharp. ──
  const header = req.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || !bearerMatches(presented, token)) {
    res.status(401).json({ error: { code: 'unauthorized' } });
    return;
  }

  // ── 3. POST only. Same constant 404 as unconfigured: a wrong method is not
  //        information the caller needs, and the platform never sends one. ──
  if (req.method !== 'POST') {
    res.status(404).json({ error: { code: 'not_found' } });
    return;
  }

  // ── 4. ENVELOPE. A single stable shape for every malformation; nothing
  //        names the offending field (contract §"Error bodies are constant"). ──
  const body = req.body;
  if (!isValidEnvelope(body)) {
    logger.warn('render-farm: invalid job envelope', {
      // jobId only if it happens to be a plain string — never the payload.
      jobId: isNonEmptyString(body?.jobId) ? body.jobId : null,
    });
    res.status(400).json({ error: { code: 'invalid_job' } });
    return;
  }

  const { jobId, input, profile, output } = body;

  const inputUrl = parseAllowedUrl(input.url);
  const printPutUrl = parseAllowedUrl(output.printPngPutUrl);
  const previewPutUrl = parseAllowedUrl(output.previewWebpPutUrl);
  if (!inputUrl || !printPutUrl || !previewPutUrl) {
    // Host allowlist violations are envelope faults, not job failures — the
    // caller sent a URL this farm will not touch. No URL is logged (bearer
    // capability), and the response does not say which of the three it was.
    logger.warn('render-farm: url failed allowlist', { jobId });
    res.status(400).json({ error: { code: 'invalid_job' } });
    return;
  }

  // The tightest of: what the job allows, what the profile allows, and the
  // farm's own hard ceiling. `max_file_mb` is also re-checked INSIDE the core
  // (it produces the Swedish `file_too_large` verdict); this bound exists so an
  // oversized file is never fully buffered to reach that check.
  const profileBytes = profile.max_file_mb ? Math.floor(profile.max_file_mb * 1024 * 1024) : HARD_MAX_INPUT_BYTES;
  const maxBytes = Math.min(input.maxBytes, profileBytes, HARD_MAX_INPUT_BYTES);

  let buf: Buffer;
  try {
    buf = await fetchInput(inputUrl, maxBytes);
  } catch (err: any) {
    logger.error('render-farm: input fetch failed', { jobId, maxBytes, error: err?.name || 'Error', message: err?.message });
    res.status(502).json({ error: { code: 'job_failed' } });
    return;
  }

  let result;
  try {
    result = await runArtworkPipeline(buf, profile);
  } catch (err: any) {
    logger.error('render-farm: pipeline crashed', { jobId, inputBytes: buf.length, error: err?.name || 'Error', message: err?.message });
    res.status(502).json({ error: { code: 'job_failed' } });
    return;
  }

  // A gate rejection is a RESULT: the job succeeded, the artwork did not.
  if (!result.ok) {
    logger.info('render-farm: job rejected by gate', {
      jobId,
      inputBytes: buf.length,
      verdict: 'reject',
      reasonCodes: result.reasons.map((r) => r.code),
    });
    res.status(200).json({ ok: false, reasons: result.reasons });
    return;
  }

  try {
    await putOutput(printPutUrl, result.printPng, 'image/png');
    await putOutput(previewPutUrl, result.previewWebp, 'image/webp');
  } catch (err: any) {
    logger.error('render-farm: output PUT failed', {
      jobId,
      printBytes: result.printPng.length,
      previewBytes: result.previewWebp.length,
      error: err?.name || 'Error',
      message: err?.message,
    });
    res.status(502).json({ error: { code: 'job_failed' } });
    return;
  }

  logger.info('render-farm: job ok', {
    jobId,
    inputBytes: buf.length,
    printBytes: result.printPng.length,
    previewBytes: result.previewWebp.length,
    verdict: 'ok',
  });

  // The outputs are already PUT before this 200 is sent (contract §Response).
  // sha256 of each object is double-reported so the Worker can verify the PUT
  // landed the bytes the farm produced — the contract's open question, answered
  // yes: it costs one hash over data already in memory and turns a silent
  // truncated upload into a detectable one.
  res.status(200).json({
    ok: true,
    fields: result.meta,
    notices: result.notices,
    outputs: {
      printPng: { sha256: sha256Hex(result.printPng), bytes: result.printPng.length },
      previewWebp: { sha256: sha256Hex(result.previewWebp), bytes: result.previewWebp.length },
    },
  });
});
