import { authorizePlatformRequest } from "../auth/request-authorization";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import { isInviteConfigured, issueInvite } from "../platform/invites";
import type { TenantStatus } from "../platform/provision-tenants";
import {
  parseTenantIdPathSegment,
  setTenantStatus,
} from "../platform/provision-tenants";
import {
  getDirectoryUser,
  listDirectoryUsers,
  parseUserIdSegment,
  parseUserListQuery,
} from "../platform/user-directory";
import type { LifecycleRefusal, LifecycleResult } from "../platform/user-lifecycle";
import {
  deactivateUser,
  reactivateUser,
  revokeTenantAdmin,
} from "../platform/user-lifecycle";

/**
 * The platform's identity surface (CP3-B). Platform principal only; every
 * failure of the session, same-origin or path checks is the opaque 404 every
 * guarded surface answers with. GETs need no same-origin (a same-origin GET
 * carries no Origin header); every POST does.
 *
 *   GET  /v1/platform/users[?accountType][&tenantId][&cursor][&limit=1..100]
 *        200 { users: [DirectoryUser], nextCursor: string | null }
 *   GET  /v1/platform/users/:userId
 *        200 { user: DirectoryUser }
 *   POST /v1/platform/users/:userId/deactivate
 *        200 { user } · 409 cannot_deactivate_self | last_platform_admin |
 *        not_active | no_identity
 *   POST /v1/platform/users/:userId/reactivate
 *        200 { user } · 409 not_suspended | platform_admin_reactivation | no_identity
 *   POST /v1/platform/users/:userId/invite
 *        202 { invite: { userId, surface, expiresAt } } · 409 not_invitable ·
 *        503 email_unavailable
 *   POST /v1/platform/tenants/:tenantId/admins/:userId/revoke
 *        200 { membership } · 409 already_revoked
 *   POST /v1/platform/tenants/:tenantId/activate | /suspend   (review round 1)
 *        200 { tenant } · 409 tenant_closed
 *
 * `POST /v1/platform/users` (create) stays in provision-users.ts / app.ts; the
 * directory GET is registered before it and claims only GET.
 */

export const PLATFORM_USER_DIRECTORY_PATH = "/v1/platform/users";
export const PLATFORM_USER_ROUTE = "/v1/platform/users/:userId";
export const PLATFORM_USER_DEACTIVATE_ROUTE = "/v1/platform/users/:userId/deactivate";
export const PLATFORM_USER_REACTIVATE_ROUTE = "/v1/platform/users/:userId/reactivate";
export const PLATFORM_USER_INVITE_ROUTE = "/v1/platform/users/:userId/invite";
export const PLATFORM_TENANT_ADMIN_REVOKE_ROUTE =
  "/v1/platform/tenants/:tenantId/admins/:userId/revoke";
export const PLATFORM_TENANT_ACTIVATE_ROUTE = "/v1/platform/tenants/:tenantId/activate";
export const PLATFORM_TENANT_SUSPEND_ROUTE = "/v1/platform/tenants/:tenantId/suspend";

function parseTenantSegment(raw: string): string | null {
  const decoded = decodeSegment(raw);
  return decoded === null ? null : parseTenantIdPathSegment(decoded);
}

type Refusal = LifecycleRefusal | "not_invitable";

const REFUSAL_MESSAGES: Record<Refusal, string> = {
  already_revoked: "The membership is already revoked",
  cannot_deactivate_self: "An operator cannot deactivate their own identity",
  last_platform_admin: "At least one active platform admin must remain",
  no_identity: "The user holds no identity to change",
  not_active: "The identity is not active",
  not_invitable: "The identity cannot be invited",
  not_suspended: "The identity is not suspended",
  platform_admin_reactivation: "A platform admin cannot be reactivated over HTTP",
};

function refusalResponse(reason: Refusal): Response {
  return jsonResponse(
    { error: { code: reason, message: REFUSAL_MESSAGES[reason] } },
    409,
  );
}

async function authorizePlatformWrite(env: Env, request: Request) {
  const principal = await authorizePlatformRequest(env, request);
  return principal === null ||
    !isSameOriginRequest(request) ||
    request.method !== "POST"
    ? null
    : principal;
}

export async function handlePlatformUserDirectoryRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }

  const query = parseUserListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }

  return jsonResponse(await listDirectoryUsers(env.DB, query, Date.now()));
}

export async function handlePlatformUserReadRoute(
  env: Env,
  request: Request,
  rawUserId: string,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }

  const userId = parseUserIdSegment(rawUserId);
  const user =
    userId === null ? null : await getDirectoryUser(env.DB, userId, Date.now());
  return user === null ? routeNotFoundResponse() : jsonResponse({ user });
}

async function lifecycleResponse(
  env: Env,
  result: LifecycleResult,
  userId: string,
): Promise<Response> {
  if (result.status === "refused") {
    return refusalResponse(result.reason);
  }
  const user =
    result.status === "ok" ? await getDirectoryUser(env.DB, userId, Date.now()) : null;
  return user === null ? routeNotFoundResponse() : jsonResponse({ user });
}

export async function handlePlatformUserLifecycleRoute(
  env: Env,
  request: Request,
  action: "deactivate" | "reactivate",
  rawUserId: string,
): Promise<Response> {
  const principal = await authorizePlatformWrite(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  const userId = parseUserIdSegment(rawUserId);
  if (userId === null) {
    return routeNotFoundResponse();
  }

  const now = Date.now();
  const result =
    action === "deactivate"
      ? await deactivateUser(env.DB, principal, userId, now)
      : await reactivateUser(env.DB, principal, userId, now);

  return lifecycleResponse(env, result, userId);
}

export async function handlePlatformUserInviteRoute(
  env: Env,
  request: Request,
  rawUserId: string,
): Promise<Response> {
  // The configuration gate first: without a queue and an allowlist the surface
  // is indistinguishable from one that was never deployed (as the reset routes).
  if (!isInviteConfigured(env)) {
    return routeNotFoundResponse();
  }

  const principal = await authorizePlatformWrite(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  const userId = parseUserIdSegment(rawUserId);
  if (userId === null) {
    return routeNotFoundResponse();
  }

  const result = await issueInvite(env, principal, userId, Date.now());
  switch (result.status) {
    case "ok":
      // Accepted for delivery. The body never carries the token or the link.
      return jsonResponse({ invite: result.invite }, 202);
    case "not_invitable":
      return refusalResponse("not_invitable");
    case "email_unavailable":
      return jsonResponse(
        {
          error: {
            code: "email_unavailable",
            message: "The invite email could not be queued",
          },
        },
        503,
      );
    default:
      return routeNotFoundResponse();
  }
}

export async function handlePlatformTenantAdminRevokeRoute(
  env: Env,
  request: Request,
  rawTenantId: string,
  rawUserId: string,
): Promise<Response> {
  const principal = await authorizePlatformWrite(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  const tenantId = parseTenantSegment(rawTenantId);
  const userId = parseUserIdSegment(rawUserId);
  if (tenantId === null || userId === null) {
    return routeNotFoundResponse();
  }

  const result = await revokeTenantAdmin(
    env.DB,
    principal,
    tenantId,
    userId,
    Date.now(),
  );
  if (result.status === "ok") {
    return jsonResponse({ membership: result.membership });
  }
  return result.status === "refused"
    ? refusalResponse(result.reason)
    : routeNotFoundResponse();
}

/**
 * `POST /v1/platform/tenants/:tenantId/activate | /suspend` (review round 1).
 *
 * Registered in CP3-ROUTES-B, before the older tenant handler in app.ts, which
 * answered the same requests. Guard order (live platform session, same-origin,
 * path) and every response are that handler's — 200 `{ tenant }`, the opaque
 * 404 for an unknown tenant — except one: a CLOSED shop (0032: closed is final)
 * answers `409 tenant_closed` here, where the older handler could only map a
 * refusal to the generic `409 conflict`. setTenantStatus writes nothing for a
 * closed shop; the refusal is in its UPDATE's WHERE.
 */
export async function handlePlatformTenantStatusRoute(
  env: Env,
  request: Request,
  status: TenantStatus,
  rawTenantId: string,
): Promise<Response> {
  const principal = await authorizePlatformWrite(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  const tenantId = parseTenantSegment(rawTenantId);
  if (tenantId === null) {
    return routeNotFoundResponse();
  }

  const result = await setTenantStatus(env.DB, principal, tenantId, status, Date.now());
  if (result.status === "ok") {
    return jsonResponse({ tenant: result.tenant }, 200);
  }
  if (result.status === "conflict") {
    return result.code === "tenant_closed"
      ? jsonResponse(
          {
            error: {
              code: "tenant_closed",
              message: "A closed shop cannot be activated or suspended",
            },
          },
          409,
        )
      : jsonResponse(
          {
            error: {
              code: "conflict",
              message: "Request conflicts with the current tenant state",
            },
          },
          409,
        );
  }
  return routeNotFoundResponse();
}
