import { authorizePlatformRequest } from "../auth/request-authorization";
import type { ScreeningStatus } from "../catalog/screening-core";
import {
  decideByPlatform,
  listScreeningQueue,
  parsePlatformDecisionInput,
} from "../catalog/screening";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import {
  dispatchTargetOf,
  parseReplacePrintersInput,
  printersAllowedIn,
  replacePrinters,
} from "../pod/printers";

/**
 * The platform side of the POD product path (CP2-C):
 *
 *   PUT  /v1/platform/printers                 replace the printer set (+ tiers)
 *   GET  /v1/platform/screening[?status=]      the review queue
 *   POST /v1/platform/screening/{productId}    { "decision": "approved"|"blocked" }
 *
 * Platform-guarded (live platform_admin session), same-origin on every state
 * change, and every failure before authorization is the opaque 404.
 */
export const PLATFORM_PRINTERS_PATH = "/v1/platform/printers";
export const PLATFORM_SCREENING_PATH = "/v1/platform/screening";
export const PLATFORM_SCREENING_PATH_PREFIX = "/v1/platform/screening/";

const SCREENING_STATUSES: readonly ScreeningStatus[] = [
  "advisory",
  "approved",
  "blocked",
  "flagged",
  "pending",
];

/**
 * Replace-all, like PUT /v1/platform/pod/profiles: the printer set is a
 * document (SnapWear's catalogue + the platform's price list). DARK (404) unless
 * this environment has a dispatch target it can seed — `fake-printer` only in
 * staging, `snapwear` in production — and an `api` printer must BE that target
 * (src/pod/printers.ts printersAllowedIn). A routing edit that removes a
 * capability or a price suspends the affected mappings in the same batch.
 */
export async function handlePlatformPrintersRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const target = dispatchTargetOf(env);
  if (target === null) {
    return routeNotFoundResponse();
  }
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !isSameOriginRequest(request) || request.method !== "PUT") {
    return routeNotFoundResponse();
  }

  const printers = parseReplacePrintersInput(await readJsonBody(request));
  if (printers === null || !printersAllowedIn(printers, target)) {
    return invalidRequestResponse();
  }

  const result = await replacePrinters(env.DB, principal, printers, Date.now());
  if (result === null) {
    return jsonResponse(
      { error: { code: "conflict", message: "A tenant printer already uses that id" } },
      409,
    );
  }
  return jsonResponse(result, 200);
}

export async function handlePlatformScreeningRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }

  const url = new URL(request.url);
  if (url.pathname === PLATFORM_SCREENING_PATH) {
    if (request.method !== "GET") {
      return routeNotFoundResponse();
    }
    const raw = url.searchParams.get("status");
    const status =
      raw === null
        ? null
        : (SCREENING_STATUSES as readonly string[]).includes(raw)
          ? (raw as ScreeningStatus)
          : undefined;
    if (status === undefined) {
      return invalidRequestResponse();
    }
    return jsonResponse({ screening: await listScreeningQueue(env.DB, status) });
  }

  if (!url.pathname.startsWith(PLATFORM_SCREENING_PATH_PREFIX) || request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const rest = url.pathname.slice(PLATFORM_SCREENING_PATH_PREFIX.length);
  const productId = rest.includes("/") ? null : decodeSegment(rest);
  if (productId === null) {
    return routeNotFoundResponse();
  }

  const decision = parsePlatformDecisionInput(await readJsonBody(request));
  if (decision === null) {
    return invalidRequestResponse();
  }
  const screening = await decideByPlatform(env.DB, principal, productId, decision, Date.now());
  return screening === null ? routeNotFoundResponse() : jsonResponse({ screening });
}
