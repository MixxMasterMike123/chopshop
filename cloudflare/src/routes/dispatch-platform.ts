import { authorizePlatformRequest } from "../auth/request-authorization";
import {
  listDispatches,
  parseDispatchListQuery,
  parseResolveDispatchInput,
  resolveDispatch,
} from "../dispatch/resolution";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import { isOutboxId } from "../outbox/nudge";

export const PLATFORM_DISPATCH_PATH = "/v1/platform/dispatch";
export const PLATFORM_DISPATCH_RESOLVE_ROUTE = "/v1/platform/dispatch/:outboxId/resolve";

/**
 * `GET /v1/platform/dispatch?state=unknown|failed[&cursor][&limit]`
 *   200 { dispatches: [DispatchView], nextCursor: string | null }
 *
 * The dispatches that need a human, across shops (platform principal). A read:
 * no same-origin requirement (as for admin GETs); `SameSite=Lax` cookies and
 * the live platform check are the gate.
 */
export async function handlePlatformDispatchListRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }

  const query = parseDispatchListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  return jsonResponse(await listDispatches(env.DB, query), 200);
}

/**
 * `POST /v1/platform/dispatch/{outboxId}/resolve`
 *   body { outcome: "accepted" | "failed", printerJobRef?: string, note: string }
 *   200 { dispatch: DispatchView }
 *   409 { error: { code: "conflict", … } } — not awaiting resolution (in flight,
 *       done, superseded, or moved since it was read)
 *   400 invalid body · 404 unknown id / not a dispatch / not a platform user
 *
 * Recorded with who/when/why in audit_events (`dispatch.resolve`).
 */
export async function handlePlatformDispatchResolveRoute(
  env: Env,
  request: Request,
  rawOutboxId: string,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !isSameOriginRequest(request) || request.method !== "POST") {
    return routeNotFoundResponse();
  }

  const outboxId = decodeSegment(rawOutboxId);
  if (outboxId === null || !isOutboxId(outboxId)) {
    return routeNotFoundResponse();
  }

  const input = parseResolveDispatchInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await resolveDispatch(env, principal, outboxId, input, Date.now());
  if (result.status === "not_found") {
    return routeNotFoundResponse();
  }
  if (result.status === "conflict") {
    return jsonResponse(
      {
        error: {
          code: "conflict",
          message: "The dispatch is not awaiting resolution",
        },
      },
      409,
    );
  }
  return jsonResponse({ dispatch: result.dispatch }, 200);
}
