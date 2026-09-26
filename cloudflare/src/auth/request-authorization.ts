import type {
  PlatformPrincipal,
  PrintPrincipal,
  TenantAdminPrincipal,
} from "./live-authorization";
import {
  authorizePlatformAdmin,
  authorizePrintOperator,
  authorizeTenantAdmin,
} from "./live-authorization";
import { createAuth, isAuthConfigured } from "./create-auth";
import { findActiveActingAsGrant } from "../platform/acting-as";
import { parseTenantIdPathSegment } from "../platform/provision-tenants";

/**
 * The header that names the ACTIVE SHOP on every tenant-admin request
 * (PLAN §2.1). Admin, platform and print each live on one hostname, so the
 * hostname can no longer say which shop a request is about; the client says so
 * explicitly and the server checks that claim against live records.
 */
export const SHOP_ID_HEADER = "x-shop-id";

/**
 * The shop id a request names, or null. Same grammar as a tenant id anywhere
 * else (lowercase, bounded, no dots), so a malformed value is refused before any
 * session or database work — and refused with the same 404 as everything else.
 */
export function parseShopIdHeader(value: string | null): string | null {
  return value === null ? null : parseTenantIdPathSegment(value);
}

export interface SessionIdentity {
  userId: string;
}

export async function resolveSessionIdentity(
  env: Env,
  request: Request,
): Promise<SessionIdentity | null> {
  // Without a configured auth secret no session can exist, so every
  // session-guarded surface fails closed as anonymous instead of throwing.
  if (!isAuthConfigured(env)) {
    return null;
  }

  const result = await createAuth(env).api.getSession({
    headers: request.headers,
  });

  if (result?.user.id === undefined) {
    return null;
  }

  return { userId: result.user.id };
}

export async function authorizePlatformRequest(
  env: Env,
  request: Request,
): Promise<PlatformPrincipal | null> {
  const identity = await resolveSessionIdentity(env, request);
  return identity === null
    ? null
    : authorizePlatformAdmin(env.DB, identity.userId);
}

/**
 * The tenant-admin guard: which shop, and may this session administer it?
 *
 * The shop is the one the request NAMES in `X-Shop-Id` — never the hostname,
 * which on the admin surface is one shared host for every shop. The claim is
 * worth nothing on its own: it is accepted only when the session's user holds a
 * live, active `admin` membership in that shop (and the shop and the identity
 * are both active), or — for a platform user — an unexpired, unrevoked acting-as
 * grant on it while their platform_admin record is still active.
 *
 * Every failure is the same null, which every caller turns into the same opaque
 * 404: a missing header, a malformed one, a shop the user has no rights in, and
 * a shop that does not exist are indistinguishable from outside.
 */
export async function authorizeTenantAdminRequest(
  env: Env,
  request: Request,
): Promise<TenantAdminPrincipal | null> {
  const shopId = parseShopIdHeader(request.headers.get(SHOP_ID_HEADER));
  if (shopId === null) {
    return null;
  }

  const identity = await resolveSessionIdentity(env, request);
  if (identity === null) {
    return null;
  }

  const member = await authorizeTenantAdmin(env.DB, identity.userId, shopId);
  if (member !== null) {
    return member;
  }

  const grant = await findActiveActingAsGrant(
    env.DB,
    identity.userId,
    shopId,
    Date.now(),
  );
  if (grant === null) {
    return null;
  }

  return {
    accountType: "tenant_admin",
    actingAs: { grantId: grant.grantId },
    role: "admin",
    tenantId: shopId,
    userId: identity.userId,
  };
}

export async function authorizePrintRequest(
  env: Env,
  request: Request,
  tenantId: string,
): Promise<PrintPrincipal | null> {
  const identity = await resolveSessionIdentity(env, request);
  return identity === null
    ? null
    : authorizePrintOperator(env.DB, identity.userId, tenantId);
}

export async function revokeUserSessions(
  db: D1Database,
  userId: string,
): Promise<number> {
  const result = await db
    .prepare('DELETE FROM "session" WHERE "userId" = ?')
    .bind(userId)
    .run();

  return result.meta.changes;
}
