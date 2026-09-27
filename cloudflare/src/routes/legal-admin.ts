import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import {
  acceptPlatformTerms,
  parseAcceptTermsInput,
  readTermsStatus,
} from "../legal/platform-terms";
import { jsonResponse } from "../lib/http";
import { clientIp } from "../lib/rate-limit";
import {
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

/**
 * The shop admin's platform-terms surface (CP2-E, migrations/0031):
 *
 *   GET  /v1/admin/legal/status
 *        200 { currentVersion: string | null, accepted: boolean, acceptedAt: string | null }
 *
 *   POST /v1/admin/legal/accept-terms   { termsVersion }
 *        201 { acceptance: { termsVersion, acceptedAt } }   recorded now
 *        200 { acceptance: { termsVersion, acceptedAt } }   already accepted (the first one)
 *        409 { error: { code: "terms_version_not_current", … }, currentVersion }
 *        400 invalid_request                                 body is not exactly { termsVersion }
 *        404                                                 everything else — no session, no
 *            membership, cross-origin, and an ACTING-AS platform user (the seller signs, never
 *            the platform on the seller's behalf)
 *
 * Tenant = `X-Shop-Id` checked against the session's memberships, like every
 * tenant-admin surface; the state change also requires a same-origin request.
 */

export const ADMIN_LEGAL_STATUS_PATH = "/v1/admin/legal/status";
export const ADMIN_LEGAL_ACCEPT_TERMS_PATH = "/v1/admin/legal/accept-terms";

export async function handleAdminLegalStatusRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  const status = await readTermsStatus(env.DB, principal.tenantId, Date.now());
  return jsonResponse({
    accepted: status.acceptedAt !== null,
    acceptedAt: status.acceptedAt,
    currentVersion: status.currentVersion,
  });
}

export async function handleAdminLegalAcceptTermsRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || !isSameOriginRequest(request) || principal.actingAs !== undefined) {
    return routeNotFoundResponse();
  }

  const input = parseAcceptTermsInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await acceptPlatformTerms(
    env.DB,
    principal,
    input,
    {
      ip: request.headers.has("cf-connecting-ip") ? clientIp(request) : null,
      origin: request.headers.get("origin"),
      userAgent: request.headers.get("user-agent"),
    },
    Date.now(),
  );

  switch (result.status) {
    case "accepted":
      return jsonResponse({ acceptance: result.acceptance }, 201);
    case "already_accepted":
      return jsonResponse({ acceptance: result.acceptance }, 200);
    case "not_current":
      return jsonResponse(
        {
          currentVersion: result.currentVersion,
          error: {
            code: "terms_version_not_current",
            message: "The terms version is not the current one",
          },
        },
        409,
      );
    default:
      return routeNotFoundResponse();
  }
}
