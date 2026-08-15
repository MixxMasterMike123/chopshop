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
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

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

export async function authorizeTenantAdminRequest(
  env: Env,
  request: Request,
): Promise<TenantAdminPrincipal | null> {
  const [identity, tenant] = await Promise.all([
    resolveSessionIdentity(env, request),
    resolveRequestTenant(env.DB, request),
  ]);

  if (identity === null || tenant === null) {
    return null;
  }

  return authorizeTenantAdmin(env.DB, identity.userId, tenant.tenantId);
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
