import type { PlatformPrincipal } from "../auth/live-authorization";

/**
 * Identity lifecycle for platform operators (CP3-B): deactivate, reactivate,
 * and revoke one tenant-admin membership.
 *
 * THERE IS NO DELETE. Every foreign key onto "user" and identity_access is
 * ON DELETE RESTRICT (orders, audit rows, acceptances and memberships all point
 * at users), so "delete" — Firebase's deletePlatformUser — becomes
 * `identity_access.status = 'suspended'` here. The account row stays, the
 * history that references it stays, and nothing the identity held works.
 *
 * ── ONE GUARDED WRITE DECIDES ───────────────────────────────────────────────
 * Each operation is one D1 batch (one transaction). Its FIRST statement is the
 * conditional UPDATE that carries every guard in its WHERE clause and stamps
 * the row with a fresh `status_change_id`. Every other statement in the batch —
 * the audit row, the session revocation, the invite revocation — runs only for
 * a row carrying that stamp, so a refused change records nothing and revokes
 * nothing. There is no read-then-write anywhere on the decision path; the read
 * after a refused write only chooses the error code.
 *
 * ── THE LAST-PLATFORM-ADMIN GUARD UNDER CONCURRENCY ─────────────────────────
 * Deactivating a platform admin requires, in the same UPDATE, that ANOTHER
 * active platform admin exists. D1 executes one statement (and one batch) at a
 * time against a single SQLite database, so two requests deactivating the last
 * two admins crosswise cannot both see the other as the survivor: whichever
 * UPDATE runs second sees the first one's suspension and matches no row. The
 * caller is always counted as a survivor while they are active, which is why
 * self-deactivation has its own guard (also in the WHERE clause).
 *
 * ── SESSIONS ────────────────────────────────────────────────────────────────
 * Deactivation deletes every `session` row of the user in the same batch, so
 * the next request with an old cookie resolves no session at all. Even without
 * that, every guard re-reads identity_access live (live-authorization.ts), so a
 * suspended identity is refused on its next request regardless. Membership
 * revocation does NOT touch sessions: a session is not bound to a tenant here.
 * The shop a tenant-admin request acts on is the `X-Shop-Id` it names, checked
 * on every request against a live, active membership
 * (authorizeTenantAdminRequest); revoking one membership therefore ends access
 * to that shop on the very next request, while the same session keeps working
 * in the user's other shops. Revoking the sessions would sign the user out of
 * shops they still administer.
 */

export type LifecycleRefusal =
  | "already_revoked"
  | "cannot_deactivate_self"
  | "last_platform_admin"
  | "no_identity"
  | "not_active"
  | "not_suspended"
  | "platform_admin_reactivation";

export type LifecycleResult =
  | { status: "not_found" }
  | { status: "ok" }
  | { reason: LifecycleRefusal; status: "refused" };

export interface RevokedMembership {
  membershipId: string;
  role: "admin";
  status: "revoked";
  tenantId: string;
  userId: string;
}

export type RevokeMembershipResult =
  | { membership: RevokedMembership; status: "ok" }
  | { status: "not_found" }
  | { reason: LifecycleRefusal; status: "refused" };

interface IdentityStateRow {
  account_type: string | null;
  status: string | null;
  user_id: string;
}

async function identityState(
  db: D1Database,
  userId: string,
): Promise<IdentityStateRow | null> {
  return db
    .prepare(
      `SELECT u."id" AS user_id, a.account_type, a.status
       FROM "user" AS u
       LEFT JOIN identity_access AS a ON a.user_id = u."id"
       WHERE u."id" = ?
       LIMIT 1`,
    )
    .bind(userId)
    .first<IdentityStateRow>();
}

/**
 * Did the guarded UPDATE match its row? D1's `meta.changes` counts rows written
 * by triggers too (e.g. 0025's catalog_version bump on tenants), so a match is
 * `> 0`, never `=== 1`; a statement that matches nothing fires no trigger.
 */
function matched(result: D1Result | undefined): boolean {
  return (result?.meta.changes ?? 0) > 0;
}

function stamped(userId: string, changeId: string): { binds: string[]; sql: string } {
  return {
    binds: [userId, changeId],
    sql: "EXISTS (SELECT 1 FROM identity_access WHERE user_id = ? AND status_change_id = ?)",
  };
}

/**
 * `identity_access.status: active → suspended`, the user's sessions and
 * outstanding invite revoked, one audit row — or nothing at all.
 */
export async function deactivateUser(
  db: D1Database,
  principal: PlatformPrincipal,
  userId: string,
  now: number,
): Promise<LifecycleResult> {
  if (userId === principal.userId) {
    return { reason: "cannot_deactivate_self", status: "refused" };
  }

  const changeId = crypto.randomUUID();
  const nowIso = new Date(now).toISOString();
  const guard = stamped(userId, changeId);

  const [decision] = await db.batch([
    // THE decision. Target active; not the caller; and, for a platform admin,
    // another active platform admin exists at the moment this statement runs.
    db
      .prepare(
        `UPDATE identity_access
         SET status = 'suspended',
             updated_at = MAX(updated_at, ?),
             status_change_id = ?
         WHERE user_id = ?
           AND user_id <> ?
           AND status = 'active'
           AND (
             account_type <> 'platform_admin'
             OR EXISTS (
               SELECT 1 FROM identity_access AS survivor
               WHERE survivor.account_type = 'platform_admin'
                 AND survivor.status = 'active'
                 AND survivor.user_id <> ?
             )
           )`,
      )
      .bind(now, changeId, userId, principal.userId, userId),
    // Written before the revocations below so its counts are what they revoke.
    // No email: the identity's id is the resource, the kind is the fact.
    db
      .prepare(
        `INSERT INTO audit_events (
          event_id, tenant_id, actor_user_id, action, resource_type,
          resource_id, reason, request_id, metadata_json, created_at
        )
        SELECT ?, NULL, ?, 'platform.user_deactivate', 'identity_access',
          user_id, NULL, ?,
          json_object(
            'accountType', account_type,
            'changeId', ?,
            'sessionsRevoked', (SELECT COUNT(*) FROM "session" WHERE "userId" = ?),
            'invitesRevoked', (
              SELECT COUNT(*) FROM identity_invites WHERE user_id = ? AND status = 'issued'
            )
          ),
          ?
        FROM identity_access
        WHERE user_id = ? AND status_change_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        crypto.randomUUID(),
        changeId,
        userId,
        userId,
        now,
        userId,
        changeId,
      ),
    db
      .prepare(`DELETE FROM "session" WHERE "userId" = ? AND ${guard.sql}`)
      .bind(userId, ...guard.binds),
    // An outstanding invite would otherwise let a suspended identity set a
    // password, and would come back to life on reactivation.
    db
      .prepare(
        `DELETE FROM "verification"
         WHERE "id" IN (
           SELECT verification_id FROM identity_invites
           WHERE user_id = ? AND status = 'issued'
         )
           AND ${guard.sql}`,
      )
      .bind(userId, ...guard.binds),
    db
      .prepare(
        `UPDATE identity_invites
         SET status = 'revoked', updated_at = MAX(updated_at, ?)
         WHERE user_id = ? AND status = 'issued' AND ${guard.sql}`,
      )
      .bind(nowIso, userId, ...guard.binds),
  ]);

  if (matched(decision)) {
    return { status: "ok" };
  }

  // Refused. The guard already decided; this read only names the reason.
  const state = await identityState(db, userId);
  if (state === null) {
    return { status: "not_found" };
  }
  if (state.status === null) {
    return { reason: "no_identity", status: "refused" };
  }
  if (state.status !== "active") {
    return { reason: "not_active", status: "refused" };
  }
  return state.account_type === "platform_admin"
    ? { reason: "last_platform_admin", status: "refused" }
    : { reason: "not_active", status: "refused" };
}

/**
 * `identity_access.status: suspended → active`. Sessions are not restored (the
 * deactivation deleted them): the user signs in again. Invites revoked by the
 * deactivation stay revoked; the operator issues a new one if needed.
 *
 * A PLATFORM ADMIN IS NOT REACTIVATED OVER HTTP. Same floor as
 * provision-users.ts and DECISIONS D51: a hijacked platform session must not be
 * able to bring back an identity another operator switched off (possibly
 * because it was compromised) and so outlive the revocation of the original.
 * Restoring a platform admin is a script + review, like creating one.
 */
export async function reactivateUser(
  db: D1Database,
  principal: PlatformPrincipal,
  userId: string,
  now: number,
): Promise<LifecycleResult> {
  const changeId = crypto.randomUUID();

  const [decision] = await db.batch([
    db
      .prepare(
        `UPDATE identity_access
         SET status = 'active',
             updated_at = MAX(updated_at, ?),
             status_change_id = ?
         WHERE user_id = ?
           AND status = 'suspended'
           AND account_type <> 'platform_admin'`,
      )
      .bind(now, changeId, userId),
    db
      .prepare(
        `INSERT INTO audit_events (
          event_id, tenant_id, actor_user_id, action, resource_type,
          resource_id, reason, request_id, metadata_json, created_at
        )
        SELECT ?, NULL, ?, 'platform.user_reactivate', 'identity_access',
          user_id, NULL, ?,
          json_object('accountType', account_type, 'changeId', ?),
          ?
        FROM identity_access
        WHERE user_id = ? AND status_change_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        crypto.randomUUID(),
        changeId,
        now,
        userId,
        changeId,
      ),
  ]);

  if (matched(decision)) {
    return { status: "ok" };
  }

  const state = await identityState(db, userId);
  if (state === null) {
    return { status: "not_found" };
  }
  if (state.status === null) {
    return { reason: "no_identity", status: "refused" };
  }
  if (state.status === "suspended" && state.account_type === "platform_admin") {
    return { reason: "platform_admin_reactivation", status: "refused" };
  }
  return { reason: "not_suspended", status: "refused" };
}

/**
 * `tenant_memberships.status → revoked` for one (tenant, user, admin) row.
 *
 * The identity is untouched. A tenant admin whose only membership is revoked
 * keeps an active `tenant_admin` identity with no shop: they can still sign in,
 * and every tenant-admin request answers the opaque 404 because no `X-Shop-Id`
 * matches an active membership. The account remains available to be granted
 * a shop again (POST /v1/platform/tenants/:id/admins): for the SAME shop the
 * grant re-activates this revoked row, audited as `tenant.admin_reactivate`
 * (grantTenantAdmin in provision-tenants.ts).
 */
export async function revokeTenantAdmin(
  db: D1Database,
  principal: PlatformPrincipal,
  tenantId: string,
  userId: string,
  now: number,
): Promise<RevokeMembershipResult> {
  const changeId = crypto.randomUUID();

  const [decision] = await db.batch<{ membership_id: string }>([
    db
      .prepare(
        `UPDATE tenant_memberships
         SET status = 'revoked',
             updated_at = MAX(updated_at, ?),
             status_change_id = ?
         WHERE tenant_id = ?
           AND user_id = ?
           AND role = 'admin'
           AND status <> 'revoked'
         RETURNING membership_id`,
      )
      .bind(now, changeId, tenantId, userId),
    db
      .prepare(
        `INSERT INTO audit_events (
          event_id, tenant_id, actor_user_id, action, resource_type,
          resource_id, reason, request_id, metadata_json, created_at
        )
        SELECT ?, tenant_id, ?, 'tenant.admin_revoke', 'tenant_membership',
          membership_id, NULL, ?,
          json_object('userId', user_id, 'changeId', ?),
          ?
        FROM tenant_memberships
        WHERE tenant_id = ? AND user_id = ? AND role = 'admin' AND status_change_id = ?`,
      )
      .bind(
        crypto.randomUUID(),
        principal.userId,
        crypto.randomUUID(),
        changeId,
        now,
        tenantId,
        userId,
        changeId,
      ),
  ]);

  const revoked = decision?.results[0];
  if (revoked !== undefined) {
    return {
      membership: {
        membershipId: revoked.membership_id,
        role: "admin",
        status: "revoked",
        tenantId,
        userId,
      },
      status: "ok",
    };
  }

  const existing = await db
    .prepare(
      `SELECT status FROM tenant_memberships
       WHERE tenant_id = ? AND user_id = ? AND role = 'admin'
       LIMIT 1`,
    )
    .bind(tenantId, userId)
    .first<{ status: string }>();

  return existing === null
    ? { status: "not_found" }
    : { reason: "already_revoked", status: "refused" };
}
