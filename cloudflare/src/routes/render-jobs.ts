import { readBearerToken, secretMatches } from "../lib/bearer";
import { jsonResponse } from "../lib/http";
import { clientIp, enforceRateLimit } from "../lib/rate-limit";
import {
  decodeSegment,
  invalidRequestResponse,
  notFoundResponse,
  rateLimitedResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import {
  acquireRenderJob,
  completeRenderJob,
  failRenderJob,
  isRenderJobsConfigured,
} from "../pod/render-jobs";

/**
 * The render farm's pull surface (PLAN §2.6):
 *
 *   POST /v1/render/jobs/acquire          → 200 lease + envelope | 204 empty
 *   POST /v1/render/jobs/{id}/complete    → 200 | 400 | 404 | 409 | 422
 *   POST /v1/render/jobs/{id}/fail        → 200 | 400 | 404 | 409
 *
 * Authenticated ONLY by `Authorization: Bearer <RENDER_FARM_TOKEN>` (constant-
 * time). No session, no cookie, no tenant hostname: the farm is the platform's
 * own component and works across every tenant; tenancy lives in the job rows.
 *
 * Order, and why: the configuration gate FIRST (an unconfigured deployment is
 * indistinguishable from one where this was never written, and touches no D1),
 * then the per-IP limiter (before the token compare, so a brute force pays for
 * its attempts), then the token. Every auth failure is the same opaque 404 as
 * an unknown path.
 */
export const RENDER_API_PATH_PREFIX = "/v1/render/";

/**
 * Generous for the honest caller — an idle farm polls acquire every few
 * seconds and each job costs one or two more calls — while still bounding what
 * an unauthenticated flood from one address can make this route do (one D1
 * write per request, and nothing past the token compare).
 */
export const RENDER_API_IP_SCOPE = "render-api-ip";
export const RENDER_API_IP_LIMIT = 120;
export const RENDER_API_IP_WINDOW_MS = 60 * 1_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type RenderRoute =
  | { action: "acquire" }
  | { action: "complete" | "fail"; jobId: string };

function parseRenderRoute(pathname: string): RenderRoute | null {
  if (!pathname.startsWith(RENDER_API_PATH_PREFIX)) {
    return null;
  }

  const segments = pathname.slice(RENDER_API_PATH_PREFIX.length).split("/");
  if (segments.length === 2 && segments[0] === "jobs" && segments[1] === "acquire") {
    return { action: "acquire" };
  }

  const [jobs, rawId, action, ...rest] = segments;
  if (
    jobs !== "jobs" ||
    rawId === undefined ||
    rest.length > 0 ||
    (action !== "complete" && action !== "fail")
  ) {
    return null;
  }

  const jobId = decodeSegment(rawId);
  return jobId !== null && UUID_PATTERN.test(jobId) ? { action, jobId } : null;
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function leaseLostResponse(): Response {
  return errorResponse(409, "lease_lost", "The lease on this job is no longer held");
}

export async function handleRenderJobsRoute(
  env: Env,
  request: Request,
  pathname: string,
): Promise<Response> {
  if (!isRenderJobsConfigured(env)) {
    return routeNotFoundResponse();
  }

  const now = Date.now();
  const byIp = await enforceRateLimit(env.DB, {
    key: clientIp(request),
    limit: RENDER_API_IP_LIMIT,
    now,
    scope: RENDER_API_IP_SCOPE,
    windowMs: RENDER_API_IP_WINDOW_MS,
  });
  if (!byIp.allowed) {
    return rateLimitedResponse(byIp.retryAfterSeconds);
  }

  const presented = readBearerToken(request.headers.get("authorization"));
  if (
    presented === null ||
    !(await secretMatches(presented, env.RENDER_FARM_TOKEN as string))
  ) {
    return routeNotFoundResponse();
  }

  const route = parseRenderRoute(pathname);
  if (route === null || request.method !== "POST") {
    return routeNotFoundResponse();
  }

  if (route.action === "acquire") {
    const lease = await acquireRenderJob(env, env.DB, now);
    // jsonResponse sets no-store: the body carries a lease token and
    // capability URLs.
    return lease === null ? new Response(null, { status: 204 }) : jsonResponse(lease);
  }

  const body = await readJsonBody(request);

  if (route.action === "fail") {
    const failed = await failRenderJob(env, env.DB, route.jobId, body, now);
    switch (failed.status) {
      case "queued":
      case "failed":
        return jsonResponse({ status: failed.status });
      case "invalid":
        return invalidRequestResponse();
      case "not_found":
        return notFoundResponse("Job not found");
      case "stale":
        return leaseLostResponse();
    }
  }

  const completed = await completeRenderJob(env, env.DB, route.jobId, body, now);
  switch (completed.status) {
    case "completed":
      return jsonResponse({ status: "completed" });
    case "invalid":
      return invalidRequestResponse();
    case "not_found":
      return notFoundResponse("Job not found");
    case "stale":
      return leaseLostResponse();
    case "outputs_unverified":
      return errorResponse(
        422,
        "outputs_unverified",
        "The reported outputs could not be verified",
      );
    case "canonical_conflict":
      return errorResponse(
        409,
        "canonical_conflict",
        "The canonical outputs already exist with different content",
      );
  }
}
