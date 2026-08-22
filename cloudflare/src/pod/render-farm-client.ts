import { AwsClient } from "aws4fetch";

/**
 * The render-farm client — this worker's half of docs/RENDER_FARM_CONTRACT.md.
 *
 * ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
 * The hybrid architecture has exactly one seam: Cloudflare is the system of
 * record and the whole synchronous HTTP surface, and Firebase is demoted to a
 * stateless media-compute appliance reached only through the job contract. This
 * file is the CALLER of that contract. Its counterpart is
 * `functions/src/render-farm/processArtworkJob.ts`, and the envelope built here
 * must satisfy THAT file's validator exactly — a drift between the two is not a
 * type error anywhere, it is a 400 in production.
 *
 * ── WHY PRESIGNED S3 URLS AND NOT WORKER-PROXIED ONES ───────────────────────
 * The farm will only touch hosts ending in `.r2.cloudflarestorage.com` (its
 * ALLOWED_INPUT_HOST_SUFFIXES, applied to the input GET and BOTH output PUTs —
 * an unchecked PUT target is an exfiltration primitive, not merely an SSRF
 * one). That allowlist is what dictates the shape here: a URL pointing back at
 * this worker would be refused, so the bytes must move directly between the
 * farm and R2's S3-compatible endpoint, and this worker must presign them.
 *
 * R2 BINDINGS CANNOT PRESIGN. `R2Bucket` has get/put/head/delete and no signing
 * capability at all — signing needs an access key pair, which a binding
 * deliberately does not carry. So the same bytes are reachable two ways in this
 * checkpoint: through the binding (used for HEAD verification and delete, where
 * it is simplest and needs no credentials) and through SigV4 against
 * `https://{accountId}.r2.cloudflarestorage.com` (used for the two capability
 * URLs handed to the farm). That is not redundancy — they are different
 * mechanisms for different jobs.
 *
 * ── WHY aws4fetch ───────────────────────────────────────────────────────────
 * Cloudflare documents it as THE way to presign R2 URLs from inside a Worker
 * (developers.cloudflare.com/r2/examples/aws/aws4fetch/), it is zero-dependency
 * and MIT, and it signs with `fetch` + `SubtleCrypto` — the two APIs workerd
 * provides natively. The alternative, `@aws-sdk/client-s3` +
 * `s3-request-presigner`, is a multi-megabyte dependency tree for one
 * signature. Version pinned EXACT in package.json; `npm audit` reports zero
 * vulnerabilities.
 *
 * Two mechanics of aws4fetch are easy to get wrong and are therefore stated
 * here rather than discovered later:
 *   1. `X-Amz-Expires` is a QUERY PARAMETER set on the Request BEFORE signing,
 *      not an option argument. The AWS SDK's `{ expiresIn }` has no equivalent.
 *   2. `service: "s3"` and `region: "auto"` must be passed explicitly. aws4fetch
 *      otherwise infers them from the hostname, and `.r2.cloudflarestorage.com`
 *      is not a hostname it can infer from.
 */

// ── contract v0 constants ───────────────────────────────────────────────────
// These four values ARE the wire format. They are duplicated in the farm's
// validator by necessity (the two codebases deploy separately), which is
// exactly why the test suite's fake farm re-validates the envelope it receives
// against them: a silent drift between the two sides is the one failure this
// seam cannot detect at build time.
const CONTRACT_VERSION = 1;
const JOB_TYPE = "pod.process_artwork";

/**
 * The farm's own hard ceiling (HARD_MAX_INPUT_BYTES in processArtworkJob.ts).
 * The envelope's `input.maxBytes` must never exceed it — the farm would clamp
 * it anyway, but sending a number the other side will silently reduce means the
 * two sides no longer agree about what was asked for.
 */
const FARM_MAX_INPUT_BYTES = 200 * 1024 * 1024;

/**
 * Content types the farm PUTs, pinned into the presigned URLs.
 *
 * R2 includes a signed `Content-Type` in `X-Amz-SignedHeaders`, so an upload
 * carrying a different one fails with 403 SignatureDoesNotMatch. That turns the
 * media type into part of the capability rather than a claim the uploader
 * makes: the print output can only ever be stored as a PNG and the preview as a
 * WebP, which is what the print spec requires and what
 * `processArtworkJob.ts` in fact sends (`putOutput(…, 'image/png')` and
 * `putOutput(…, 'image/webp')`).
 */
export const PRINT_CONTENT_TYPE = "image/png";
export const PREVIEW_CONTENT_TYPE = "image/webp";

/**
 * How long the presigned URLs stay valid.
 *
 * The farm's own ceiling is 300 seconds (`timeoutSeconds: 300`), and the input
 * GET is fetched at the START of the job while the output PUTs happen at the
 * END — so a URL minted now must still be valid 300 seconds from now, plus the
 * dispatch latency before the job begins. 900 seconds gives a 3x margin over
 * the whole job without being generous in any meaningful sense: these URLs are
 * bearer capabilities on exactly two object keys, one of which does not exist
 * yet, and they are handed to a service that already holds the shared secret.
 *
 * R2 accepts up to 604,800 seconds (7 days). Nothing about that ceiling makes a
 * long TTL appropriate here.
 */
export const PRESIGN_TTL_SECONDS = 900;

/**
 * How long this worker waits for the farm before giving up.
 *
 * PROBED, NOT ASSUMED — the Workers platform limits page states there is "no
 * set time limit on individual subrequests" and "no hard limit on duration for
 * HTTP-triggered Workers", and that waiting on a `fetch()` does NOT consume CPU
 * time (so the 30-second default CPU limit is never approached by an await).
 * What actually bounds this call, in order:
 *
 *   1. THIS TIMEOUT. It is the only bound this worker controls, which is
 *      precisely why it exists rather than being left to the platform.
 *   2. The client connection. Everything on the Workers side is conditioned on
 *      "as long as the client remains connected"; a browser or intermediate
 *      proxy that gives up may cancel the in-flight work. `ctx.waitUntil` would
 *      buy only 30 seconds past a disconnect and is therefore no rescue for a
 *      300-second job — which is a known property of the synchronous v0
 *      contract, not a defect introduced here. The contract's own note that
 *      async job types "get a contract revision with a queue + polling, not a
 *      bolt-on" is the answer when it stops being acceptable.
 *   3. The farm's 300-second function timeout, which fires first in every
 *      normal failure and produces a real HTTP response rather than a hang.
 *
 * 330 seconds = the farm's 300-second ceiling plus 30 seconds of margin for
 * dispatch, cold start and the response trip. Deliberately ABOVE the farm's
 * timeout so that a farm that is merely slow answers with its own 502 (which
 * this worker records honestly) rather than being cut off here and reported as
 * a timeout of unknown origin.
 */
export const FARM_TIMEOUT_MS = 330_000;

// ── the envelope, typed exactly as the farm validates it ────────────────────

/** The five fields `runArtworkPipeline` consumes. Nothing else may be sent. */
export interface JobProfile {
  accepted_formats: Array<{ ext: string }>;
  id: string;
  max_file_mb: number;
  min_dpi: number;
  print_area_mm: { h: number; w: number };
}

export interface JobEnvelope {
  contract: number;
  input: { maxBytes: number; url: string };
  jobId: string;
  jobType: string;
  output: { previewWebpPutUrl: string; printPngPutUrl: string };
  profile: JobProfile;
}

/** The measured facts the farm returns on success (PipelineMeta). */
export interface JobMeta {
  effectiveDpi: number;
  heightPx: number;
  maxPrintMm: { h: number; w: number };
  pipelineVersion: number;
  profileId: string;
  widthPx: number;
}

export interface JobNotice {
  code: string;
  message: string;
}

/** The farm's double-report of what it PUT, per output. */
export interface JobOutputReport {
  bytes: number;
  sha256: string;
}

/**
 * Every outcome the farm can produce, as a closed union.
 *
 * `rejected` is deliberately a RESULT and not a failure: a file that misses the
 * 300-DPI gate ran the job correctly and the artwork is what failed. Only
 * `failed` means the job itself did not complete, and it carries NO detail —
 * see the dispatch implementation for why nothing from the farm's response is
 * ever propagated.
 */
export type JobResult =
  | {
      meta: JobMeta;
      notices: JobNotice[];
      outputs: { previewWebp: JobOutputReport; printPng: JobOutputReport };
      status: "ok";
    }
  | { reasons: JobNotice[]; status: "rejected" }
  | { status: "failed" };

/**
 * The render farm seam.
 *
 * The route depends on this interface and never on `fetch`, so tests inject a
 * fake and NO test performs real HTTP. It carries one operation because the
 * contract has one job type at v0; `studio.render_video` is reserved and needs
 * the async revision, so adding a method for it now would be inventing an
 * interface for a protocol that does not exist.
 */
export interface RenderFarmClient {
  dispatch(envelope: JobEnvelope): Promise<JobResult>;
}

/**
 * The presigning seam, separate from the dispatch seam on purpose.
 *
 * A test can then drive a REAL R2 bucket through miniflare (verifying the
 * HEAD-before-ready path for real) while using URLs that no test ever
 * dereferences. Keeping presigning behind its own interface also means the
 * envelope-shape assertions in the fake farm are checking URLs produced by the
 * SAME code path the deployed worker uses, rather than test fixtures that could
 * drift from it.
 */
export interface R2Presigner {
  /**
   * `ttlSeconds` defaults to PRESIGN_TTL_SECONDS (the job's needs). The detail
   * route passes a much shorter one for preview downloads: a URL handed to a
   * browser that is about to render an image has no reason to outlive that.
   */
  presignGet(objectKey: string, ttlSeconds?: number): Promise<string>;
  presignPut(objectKey: string, contentType: string): Promise<string>;
}

// ── configuration: four values, all fail-closed ────────────────────────────

/**
 * A token/key shorter than this is treated as ABSENT.
 *
 * The same contract `isStripeConfigured` states, and the same reasoning the
 * farm's own `MIN_TOKEN_LENGTH` encodes: a placeholder, a truncated paste or an
 * empty-string secret must fail CLOSED (the surface does not exist), never open
 * a real surface behind a guessable credential.
 */
const MINIMUM_SECRET_LENGTH = 16;

/** The R2 endpoint the S3 API lives on. Account id is substituted in. */
const R2_ENDPOINT_SUFFIX = ".r2.cloudflarestorage.com";

/**
 * Whether the ENTIRE POD surface exists.
 *
 * FOUR values, and all four are required, because each one is load-bearing for
 * a different half of the job and a deployment holding three of them can do
 * nothing useful:
 *
 *   RENDER_FARM_URL           where to send the job
 *   RENDER_FARM_TOKEN         the shared secret the farm authenticates with
 *   R2_ACCESS_KEY_ID          \ the S3 credentials that make presigning
 *   R2_SECRET_ACCESS_KEY      / possible at all
 *
 * A worker with the farm's address and token but no R2 credentials could
 * dispatch a job whose URLs it cannot sign; one with credentials and no token
 * would be 401'd on every call. Partial configuration is not a degraded mode,
 * it is a broken one, so every POD route answers a fail-closed 404 until all
 * four exist — the gate running BEFORE the method check, the path parse and D1,
 * exactly as the payment and webhook surfaces do.
 *
 * RENDER_FARM_URL is treated as secret-shaped config rather than a `var`
 * deliberately: it is set with `wrangler secret put` alongside the others, so
 * `wrangler.jsonc` needs no change and the whole surface lights up on secrets
 * alone. It is also genuinely worth not publishing — the farm's URL is the
 * address of a compute endpoint, and there is no reason to put it in a config
 * file a repository holds.
 *
 * ACCOUNT ID IS NOT IN THIS LIST, and that is a deliberate, researched
 * decision: Cloudflare exposes no account id to a Worker at runtime — no
 * binding, no global, and `wrangler.jsonc`'s top-level `account_id` is a
 * deploy-time targeting field that is never injected into `env`. So it must be
 * supplied as configuration, and it is supplied as a plain `var`
 * (R2_ACCOUNT_ID) rather than a secret because it is not one: it appears in
 * plaintext inside every presigned URL this worker mints. Making it a secret
 * would be ceremony that implies a confidentiality it does not have. It is
 * still REQUIRED — a missing one leaves the surface dark, same as the rest.
 */
export function isPodConfigured(env: Env): boolean {
  return (
    typeof env.RENDER_FARM_URL === "string" &&
    env.RENDER_FARM_URL.length >= MINIMUM_SECRET_LENGTH &&
    typeof env.RENDER_FARM_TOKEN === "string" &&
    env.RENDER_FARM_TOKEN.length >= MINIMUM_SECRET_LENGTH &&
    typeof env.R2_ACCESS_KEY_ID === "string" &&
    env.R2_ACCESS_KEY_ID.length >= MINIMUM_SECRET_LENGTH &&
    typeof env.R2_SECRET_ACCESS_KEY === "string" &&
    env.R2_SECRET_ACCESS_KEY.length >= MINIMUM_SECRET_LENGTH &&
    typeof env.R2_ACCOUNT_ID === "string" &&
    env.R2_ACCOUNT_ID.length > 0 &&
    typeof env.R2_PRIVATE_BUCKET_NAME === "string" &&
    env.R2_PRIVATE_BUCKET_NAME.length > 0
  );
}

// ── test seams ─────────────────────────────────────────────────────────────

/**
 * The dispatch seam, and the same reasoning as STRIPE_GATEWAY_OVERRIDE.
 *
 * A PLAIN Symbol, not `Symbol.for`: the global registry would let any in-process
 * code mint an equal key from the string alone, whereas this one is reachable
 * only by importing this binding. It cannot collide with a binding name, cannot
 * be expressed in wrangler.jsonc, and cannot arrive from outside the process —
 * so the DEPLOYED path always constructs the real client. No test ever performs
 * real HTTP to the farm.
 */
export const RENDER_FARM_OVERRIDE: unique symbol = Symbol(
  "meteorshop.test.renderFarmClient",
);

/**
 * The presigner seam.
 *
 * It exists so tests can assert on the envelope's URLs without holding real R2
 * credentials, and so the fake farm can PUT to keys the miniflare binding also
 * sees. The DEFAULT is the real presigner, so forgetting to inject one in a
 * test produces real SigV4 output rather than a silently degraded fixture.
 */
export const R2_PRESIGNER_OVERRIDE: unique symbol = Symbol(
  "meteorshop.test.r2Presigner",
);

export function resolveRenderFarmClient(env: Env): RenderFarmClient {
  // Through `unknown`: Env has no index signature, which is the point — the
  // symbol key is not part of the deployed environment's declared shape.
  const override = (env as unknown as Record<PropertyKey, unknown>)[
    RENDER_FARM_OVERRIDE
  ];

  // Narrowed structurally rather than trusted: an override that is present but
  // not a usable client must not silently become one.
  if (
    typeof override === "object" &&
    override !== null &&
    typeof (override as RenderFarmClient).dispatch === "function"
  ) {
    return override as RenderFarmClient;
  }

  return createRenderFarmClient(env);
}

export function resolveR2Presigner(env: Env): R2Presigner {
  const override = (env as unknown as Record<PropertyKey, unknown>)[
    R2_PRESIGNER_OVERRIDE
  ];

  if (
    typeof override === "object" &&
    override !== null &&
    typeof (override as R2Presigner).presignGet === "function" &&
    typeof (override as R2Presigner).presignPut === "function"
  ) {
    return override as R2Presigner;
  }

  return createR2Presigner(env);
}

// ── the real presigner ─────────────────────────────────────────────────────

export function createR2Presigner(env: Env): R2Presigner {
  if (!isPodConfigured(env)) {
    // Unreachable through the routes, which gate on isPodConfigured first. Kept
    // strict for the same reason createStripeGateway is: a future caller that
    // forgets the gate must fail loudly here rather than sign with `undefined`
    // and produce a 403 from R2 that looks like a credentials problem.
    throw new Error("POD render farm is not configured");
  }

  const accountId = env.R2_ACCOUNT_ID as string;
  const bucketName = env.R2_PRIVATE_BUCKET_NAME as string;

  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID as string,
    // Both required explicitly: aws4fetch would otherwise try to infer them
    // from the hostname, and `.r2.cloudflarestorage.com` carries neither. R2
    // documents `auto` as its region and `s3` as its service name.
    region: "auto",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
    service: "s3",
  });

  const endpoint = `https://${accountId}${R2_ENDPOINT_SUFFIX}`;

  const sign = async (
    objectKey: string,
    method: "GET" | "PUT",
    contentType: string | null,
    ttlSeconds: number,
  ): Promise<string> => {
    // Path-style addressing (`/{bucket}/{key}`), which R2 documents alongside
    // the virtual-host form. Each path segment is encoded individually so that
    // the `/` separators in the key survive while anything unusual inside a
    // segment does not become a path traversal or an unsigned character.
    const encodedKey = objectKey
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    // X-Amz-Expires rides on the URL BEFORE signing — aws4fetch has no
    // expiry option, and a value appended afterwards would fall outside the
    // signature and be rejected by R2.
    const url = `${endpoint}/${bucketName}/${encodedKey}?X-Amz-Expires=${ttlSeconds}`;

    const request =
      contentType === null
        ? new Request(url, { method })
        : new Request(url, {
            headers: { "content-type": contentType },
            method,
          });

    // `signQuery: true` is what makes this PRESIGNED: the signature moves into
    // the query string, so the farm needs no Authorization header and holds no
    // credentials of ours.
    //
    // `allHeaders: true` IS REQUIRED FOR THE CONTENT-TYPE PIN, and this is not
    // obvious — it was found by a test asserting on X-Amz-SignedHeaders rather
    // than assumed from the documentation. aws4fetch keeps an UNSIGNABLE_HEADERS
    // set containing `content-type` (alongside authorization, content-length,
    // user-agent, range…) and FILTERS IT OUT of the signature by default. So
    // setting a Content-Type header on the request and signing normally
    // produces `X-Amz-SignedHeaders=host` — the header travels, but nothing
    // binds the uploader to it, and any media type would be accepted. Verified
    // both ways under this exact version (1.0.20): default → `host`,
    // allHeaders → `content-type;host`.
    //
    // That matters here because the pin is a real part of the delivery teeth: it
    // is what makes the print output only ever storable as a PNG and the preview
    // as a WebP, so a farm bug that sent the wrong media type fails loudly with
    // SignatureDoesNotMatch instead of quietly writing a file the print portal
    // will later serve with the wrong type.
    //
    // Cloudflare's own documented example passes a Content-Type without
    // allHeaders and describes the resulting URL as pinning the type; against
    // this version that description does not hold.
    const signed = await client.sign(request, {
      aws: { allHeaders: true, signQuery: true },
    });

    return signed.url.toString();
  };

  return {
    presignGet: (objectKey: string, ttlSeconds = PRESIGN_TTL_SECONDS) =>
      sign(objectKey, "GET", null, ttlSeconds),
    presignPut: (objectKey: string, contentType: string) =>
      sign(objectKey, "PUT", contentType, PRESIGN_TTL_SECONDS),
  };
}

// ── the real dispatch client ───────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOutputReport(value: unknown): JobOutputReport | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const { bytes, sha256 } = value;
  if (
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    return null;
  }

  return { bytes, sha256 };
}

function parseMeta(value: unknown): JobMeta | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const {
    effectiveDpi,
    heightPx,
    maxPrintMm,
    pipelineVersion,
    profileId,
    widthPx,
  } = value;

  if (
    !isPlainObject(maxPrintMm) ||
    typeof maxPrintMm.w !== "number" ||
    typeof maxPrintMm.h !== "number" ||
    !Number.isSafeInteger(maxPrintMm.w) ||
    !Number.isSafeInteger(maxPrintMm.h) ||
    maxPrintMm.w < 0 ||
    maxPrintMm.h < 0 ||
    typeof widthPx !== "number" ||
    !Number.isSafeInteger(widthPx) ||
    widthPx <= 0 ||
    typeof heightPx !== "number" ||
    !Number.isSafeInteger(heightPx) ||
    heightPx <= 0 ||
    typeof effectiveDpi !== "number" ||
    !Number.isSafeInteger(effectiveDpi) ||
    effectiveDpi <= 0 ||
    typeof pipelineVersion !== "number" ||
    !Number.isSafeInteger(pipelineVersion) ||
    pipelineVersion <= 0 ||
    typeof profileId !== "string" ||
    profileId.length === 0
  ) {
    return null;
  }

  return {
    effectiveDpi,
    heightPx,
    maxPrintMm: { h: maxPrintMm.h, w: maxPrintMm.w },
    pipelineVersion,
    profileId,
    widthPx,
  };
}

/**
 * Notices and reasons share one shape: `{ code, message }` with the Swedish
 * user-facing text unchanged from the pipeline. Bounded in length and count
 * because they are persisted and later rendered — an unbounded array from an
 * upstream that misbehaves would become an unbounded D1 row.
 */
const MAX_MESSAGE_ITEMS = 20;
const MAX_MESSAGE_CODE_LENGTH = 100;
const MAX_MESSAGE_TEXT_LENGTH = 2_000;

function parseNotices(value: unknown): JobNotice[] | null {
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_ITEMS) {
    return null;
  }

  const notices: JobNotice[] = [];
  for (const entry of value) {
    if (
      !isPlainObject(entry) ||
      typeof entry.code !== "string" ||
      entry.code.length === 0 ||
      entry.code.length > MAX_MESSAGE_CODE_LENGTH ||
      typeof entry.message !== "string" ||
      entry.message.length > MAX_MESSAGE_TEXT_LENGTH
    ) {
      return null;
    }

    notices.push({ code: entry.code, message: entry.message });
  }

  return notices;
}

export function createRenderFarmClient(env: Env): RenderFarmClient {
  if (!isPodConfigured(env)) {
    throw new Error("POD render farm is not configured");
  }

  const farmUrl = env.RENDER_FARM_URL as string;
  const token = env.RENDER_FARM_TOKEN as string;

  return {
    async dispatch(envelope: JobEnvelope): Promise<JobResult> {
      let response: Response;
      try {
        response = await fetch(farmUrl, {
          body: JSON.stringify(envelope),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "POST",
          // A redirect would move a request carrying the shared secret to a
          // host nobody approved. The farm never redirects; anything that does
          // is not the farm.
          redirect: "error",
          // The only bound this worker controls. See FARM_TIMEOUT_MS.
          signal: AbortSignal.timeout(FARM_TIMEOUT_MS),
        });
      } catch {
        // Network failure, timeout, or a redirect. Detail-free by
        // construction — see the `failed` branch below.
        return { status: "failed" };
      }

      // ── EVERY farm response shape, handled explicitly ────────────────────
      // Non-2xx is 401 (token mismatch), 400 (envelope the farm rejected), 404
      // (farm unconfigured or wrong method) or 502 (input fetch, output PUT, or
      // a pipeline crash). All four collapse to one opaque `failed` here, and
      // NOTHING from the farm's response body is read, logged or propagated.
      //
      // That is not laziness about diagnostics. The farm's error bodies are
      // constant and detail-free by design, its logs are where the detail lives
      // (keyed by jobId, readable by the platform operator), and a farm
      // response is upstream text that must never reach a tenant admin's
      // browser. The caller turns this into a 502-equivalent that names neither
      // the farm nor its answer.
      if (!response.ok) {
        return { status: "failed" };
      }

      let body: unknown;
      try {
        body = await response.json<unknown>();
      } catch {
        return { status: "failed" };
      }

      if (!isPlainObject(body)) {
        return { status: "failed" };
      }

      // ── 200 { ok: false, reasons } — a VERDICT, not an error ─────────────
      // The job ran correctly; the artwork failed the gate. Reasons carry the
      // Swedish messages verbatim.
      if (body.ok === false) {
        const reasons = parseNotices(body.reasons);
        // A rejection with no reasons is unusable: the uploader would see a
        // rejected card with no explanation, and the schema refuses to store
        // it. Treating it as a job failure is the honest reading — the farm did
        // not tell us what happened.
        if (reasons === null || reasons.length === 0) {
          return { status: "failed" };
        }

        return { reasons, status: "rejected" };
      }

      if (body.ok !== true) {
        return { status: "failed" };
      }

      // ── 200 { ok: true, fields, notices, outputs } ───────────────────────
      // Every field is re-validated rather than trusted. The farm is a service
      // this platform operates, but it is still a separate deployment reached
      // over the network, and the values below go straight into a financial-
      // adjacent record that a print shop will act on. A malformed success is
      // treated as a failure, which leaves the artwork retryable rather than
      // writing a half-understood verdict.
      const meta = parseMeta(body.fields);
      const notices = parseNotices(body.notices);
      const outputs = isPlainObject(body.outputs) ? body.outputs : null;
      const printPng =
        outputs === null ? null : parseOutputReport(outputs.printPng);
      const previewWebp =
        outputs === null ? null : parseOutputReport(outputs.previewWebp);

      if (
        meta === null ||
        notices === null ||
        printPng === null ||
        previewWebp === null
      ) {
        return { status: "failed" };
      }

      return {
        meta,
        notices,
        outputs: { previewWebp, printPng },
        status: "ok",
      };
    },
  };
}

// ── envelope construction ──────────────────────────────────────────────────

/**
 * Build the contract-v0 envelope.
 *
 * Exported separately from dispatch so the route can build it, the tests can
 * assert on it, and the fake farm can validate it — one construction site, one
 * shape. `maxBytes` is the tightest of what the object actually is and what the
 * farm will accept, never merely the profile's allowance: sending a bound
 * larger than the file lets an object that grew between reserve and dispatch
 * consume more of the farm's memory than the row promised.
 */
export function buildJobEnvelope(input: {
  jobId: string;
  originalSizeBytes: number;
  previewPutUrl: string;
  printPutUrl: string;
  profile: JobProfile;
  sourceUrl: string;
}): JobEnvelope {
  return {
    contract: CONTRACT_VERSION,
    input: {
      maxBytes: Math.min(input.originalSizeBytes, FARM_MAX_INPUT_BYTES),
      url: input.sourceUrl,
    },
    jobId: input.jobId,
    jobType: JOB_TYPE,
    output: {
      previewWebpPutUrl: input.previewPutUrl,
      printPngPutUrl: input.printPutUrl,
    },
    profile: input.profile,
  };
}
