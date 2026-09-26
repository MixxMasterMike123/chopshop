import { authorizePlatformRequest } from "../auth/request-authorization";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import {
  grantActingAs,
  parseActingAsGrantInput,
  revokeActingAs,
} from "../platform/acting-as";
import { parseTenantIdPathSegment } from "../platform/provision-tenants";

export const ACTING_AS_ROUTE = "/v1/platform/tenants/:tenantId/acting-as";

/**
 * `POST|DELETE /v1/platform/tenants/{tenantId}/acting-as` — open or close a
 * platform user's time-boxed admin session inside one shop (PLAN §2.1).
 *
 * Same fail-closed shape as every other platform route: the live platform
 * session check AND the strict same-origin check run before the path is parsed
 * or the body read, so a caller without platform rights cannot learn that the
 * surface exists or which shop ids are real. Both methods change state, so
 * both require a same-origin request.
 *
 * POST answers `{ tenantId, expiresAt }` and nothing else. The grant id stays
 * server-side: the client opens the shop by sending `X-Shop-Id` on admin
 * requests, and the server finds the grant itself — there is no bearer token to
 * leak. DELETE answers 204 when it ended at least one live grant, 404 when there
 * was none.
 */
export async function handleActingAsRoute(
  env: Env,
  request: Request,
  rawTenantId: string,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }

  const decoded = decodeSegment(rawTenantId);
  const tenantId = decoded === null ? null : parseTenantIdPathSegment(decoded);
  if (tenantId === null) {
    return routeNotFoundResponse();
  }

  const now = Date.now();

  if (request.method === "POST") {
    let rawBody: string;
    try {
      rawBody = await request.text();
    } catch {
      return invalidRequestResponse();
    }

    const input = parseActingAsGrantInput(rawBody);
    if (input === null) {
      return invalidRequestResponse();
    }

    const granted = await grantActingAs(env.DB, principal, tenantId, input, now);
    if (granted.status !== "ok") {
      return routeNotFoundResponse();
    }

    return jsonResponse(
      { expiresAt: granted.expiresAt, tenantId: granted.tenantId },
      201,
    );
  }

  if (request.method === "DELETE") {
    const revoked = await revokeActingAs(env.DB, principal, tenantId, now);
    return revoked.status === "ok"
      ? new Response(null, { status: 204 })
      : routeNotFoundResponse();
  }

  return routeNotFoundResponse();
}
