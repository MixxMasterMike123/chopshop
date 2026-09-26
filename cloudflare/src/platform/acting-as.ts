import type { PlatformPrincipal } from "../auth/live-authorization";

/**
 * Acting-as grants (PLAN §2.1): how a platform user opens one shop's admin.
 *
 * See migrations/0013_acting_as.sql for the table and why a grant exists
 * instead of a membership. This module mints, revokes, and resolves grants; the
 * routes live in src/routes/acting-as.ts and the authorization check that
 * consumes a grant lives in src/auth/request-authorization.ts.
 */

/**
 * How long a grant lives. Fixed server-side and not negotiable by the caller:
 * an hour is long enough to work a support case and short enough that a
 * forgotten session closes itself the same afternoon.
 */
export const ACTING_AS_TTL_MS = 60 * 60 * 1_000;

const REASON_MAX_LENGTH = 500;
const CREATE_GRANT_KEYS = ["reason"] as const;

export interface ActingAsGrantInput {
  reason: string | null;
}

export type GrantActingAsResult =
  | { expiresAt: string; grantId: string; status: "ok"; tenantId: string }
  | { status: "not_found" };

export type RevokeActingAsResult =
  | { revoked: number; status: "ok" }
  | { status: "not_found" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The mint body is OPTIONAL. An empty body mints a grant with no reason; a
 * present body must be exactly `{ "reason": "<1..500 chars>" }`. Anything else —
 * unparseable JSON, an extra key, a non-string or blank reason — is a malformed
 * request rather than a silently ignored one.
 */
export function parseActingAsGrantInput(
  rawBody: string,
): ActingAsGrantInput | null {
  if (rawBody.trim().length === 0) {
    return { reason: null };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }

  if (
    !isPlainObject(body) ||
    !Object.keys(body).every((key) =>
      (CREATE_GRANT_KEYS as readonly string[]).includes(key),
    )
  ) {
    return null;
  }

  if (body.reason === undefined) {
    return { reason: null };
  }
  if (typeof body.reason !== "string") {
    return null;
  }

  const reason = body.reason.trim();
  return reason.length >= 1 && reason.length <= REASON_MAX_LENGTH
    ? { reason }
    : null;
}

function auditStatement(
  db: D1Database,
  principal: PlatformPrincipal,
  action: "acting_as.granted" | "acting_as.revoked",
  tenantId: string,
  reason: string | null,
  metadata: Record<string, unknown>,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        event_id, tenant_id, actor_user_id, action, resource_type,
        resource_id, reason, request_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'tenant', ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      tenantId,
      principal.userId,
      action,
      tenantId,
      reason,
      crypto.randomUUID(),
      JSON.stringify(metadata),
      now,
    );
}

async function isActiveTenant(
  db: D1Database,
  tenantId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT tenant_id FROM tenants WHERE tenant_id = ? AND status = 'active' LIMIT 1`,
    )
    .bind(tenantId)
    .first<{ tenant_id: string }>();

  return row !== null;
}

/**
 * Mints a grant and its audit row in ONE batch — there is no state in which a
 * grant exists that the audit trail does not record.
 *
 * Only an active shop can be opened: acting inside a suspended or closed shop
 * would give a platform user an admin surface its own admins no longer have.
 * An unknown and an inactive shop answer the same `not_found`.
 */
export async function grantActingAs(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  input: ActingAsGrantInput,
  now: number,
): Promise<GrantActingAsResult> {
  if (!(await isActiveTenant(db, tenantId))) {
    return { status: "not_found" };
  }

  const grantId = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ACTING_AS_TTL_MS).toISOString();

  await db.batch([
    db
      .prepare(
        `INSERT INTO acting_as_grants (
          id, platform_user_id, tenant_id, created_at, expires_at, revoked_at, reason
        ) VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        grantId,
        principal.userId,
        tenantId,
        createdAt,
        expiresAt,
        input.reason,
      ),
    auditStatement(
      db,
      principal,
      "acting_as.granted",
      tenantId,
      input.reason,
      { expiresAt, grantId },
      now,
    ),
  ]);

  return { expiresAt, grantId, status: "ok", tenantId };
}

/**
 * Revokes every live grant THIS platform user holds on the shop.
 *
 * Scoped to the caller: one operator ending their session must not end a
 * colleague's. `not_found` when there was nothing live to revoke, so a revoke
 * is never recorded in the audit trail without a grant behind it.
 */
export async function revokeActingAs(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  now: number,
): Promise<RevokeActingAsResult> {
  const nowIso = new Date(now).toISOString();
  const live = await db
    .prepare(
      `SELECT id
       FROM acting_as_grants
       WHERE platform_user_id = ?
         AND tenant_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?
       ORDER BY created_at ASC
       LIMIT 50`,
    )
    .bind(principal.userId, tenantId, nowIso)
    .all<{ id: string }>();

  const grantIds = live.results.map((row) => row.id);
  if (grantIds.length === 0) {
    return { status: "not_found" };
  }

  await db.batch([
    ...grantIds.map((grantId) =>
      db
        .prepare(
          `UPDATE acting_as_grants
           SET revoked_at = ?
           WHERE id = ?
             AND platform_user_id = ?
             AND tenant_id = ?
             AND revoked_at IS NULL`,
        )
        .bind(nowIso, grantId, principal.userId, tenantId),
    ),
    auditStatement(
      db,
      principal,
      "acting_as.revoked",
      tenantId,
      null,
      { grantIds },
      now,
    ),
  ]);

  return { revoked: grantIds.length, status: "ok" };
}

/**
 * The grant a request may act under, or null.
 *
 * Every condition is re-checked live on every request, in one query: the grant
 * is unrevoked and unexpired, the caller STILL holds an active platform_admin
 * identity (a demoted operator's grants die with the demotion), and the shop is
 * still active. Newest expiry wins when an operator holds more than one.
 */
export async function findActiveActingAsGrant(
  db: D1Database,
  userId: string,
  tenantId: string,
  now: number,
): Promise<{ grantId: string } | null> {
  const row = await db
    .prepare(
      `SELECT g.id
       FROM acting_as_grants AS g
       INNER JOIN identity_access AS access
         ON access.user_id = g.platform_user_id
       INNER JOIN tenants AS tenant
         ON tenant.tenant_id = g.tenant_id
       WHERE g.platform_user_id = ?
         AND g.tenant_id = ?
         AND g.revoked_at IS NULL
         AND g.expires_at > ?
         AND access.account_type = 'platform_admin'
         AND access.status = 'active'
         AND tenant.status = 'active'
       ORDER BY g.expires_at DESC
       LIMIT 1`,
    )
    .bind(userId, tenantId, new Date(now).toISOString())
    .first<{ id: string }>();

  return row === null ? null : { grantId: row.id };
}
