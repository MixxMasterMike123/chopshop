/**
 * CP5-WA — "who am I": the signed-in user, the account type the admin surface
 * serves, the shops they may open and the acting-as grants they hold open
 * (docs/cf-port/CP5_BRIEFS.md §0.2, `GET /v1/me`).
 *
 * Every read is live, as the authorization reads are (live-authorization.ts,
 * acting-as.ts): a user deactivated, a membership revoked or a grant ended
 * after sign-in is gone from the very next answer. The predicates are the
 * authorization's own, so what this lists is exactly what an admin request
 * would admit — with one deliberate difference: a membership of a suspended or
 * closed shop is LISTED with the shop's status (the client shows it disabled),
 * although the admin routes refuse it while the shop is not active.
 *
 * Nothing here is a capability: the list is for the picker and the banner.
 * Each admin request is still authorized on its own (`X-Shop-Id` against the
 * same live rows, request-authorization.ts).
 */

export type ServedAccountType = "platform_admin" | "tenant_admin";

export interface SessionMembership {
  published: boolean;
  role: "admin";
  shopName: string | null;
  status: string;
  tenantId: string;
}

export interface SessionGrant {
  expiresAt: string;
  shopName: string | null;
  tenantId: string;
}

export interface SessionSelf {
  accountType: ServedAccountType;
  actingAs: SessionGrant[];
  memberships: SessionMembership[];
  platform: boolean;
  user: { email: string; id: string; name: string };
}

/**
 * The bound on each list. No real seller administers a hundred shops, and a
 * platform user holds at most one live grant per shop it opened in the last
 * hour; the bound exists so the read is bounded (PLAN §2.7), not to page.
 */
export const SESSION_LIST_LIMIT = 100;

interface IdentityRow {
  account_type: ServedAccountType;
  email: string;
  name: string;
  user_id: string;
}

/**
 * The answer for `userId` at `now`, or null when the user has no ACTIVE
 * identity of a type the admin surface serves (a print operator, an ordinary
 * account, a suspended or revoked identity, no identity at all).
 */
export async function readSessionSelf(
  db: D1Database,
  userId: string,
  now: number,
): Promise<SessionSelf | null> {
  const identity = await db
    .prepare(
      `SELECT u."id" AS user_id, u."email" AS email, u."name" AS name, access.account_type
       FROM "user" AS u
       INNER JOIN identity_access AS access ON access.user_id = u."id"
       WHERE u."id" = ?
         AND access.status = 'active'
         AND access.account_type IN ('tenant_admin', 'platform_admin')
       LIMIT 1`,
    )
    .bind(userId)
    .first<IdentityRow>();
  if (identity === null) {
    return null;
  }

  const platform = identity.account_type === "platform_admin";
  return {
    accountType: identity.account_type,
    // A tenant admin cannot hold a grant (only a platform principal mints one,
    // and findActiveActingAsGrant honours one only for an active platform
    // identity); a platform user's memberships admit nothing
    // (authorizeTenantAdmin requires a tenant_admin identity). Each list is
    // therefore read only for the account type it can admit.
    actingAs: platform ? await readOpenGrants(db, identity.user_id, now) : [],
    memberships: platform ? [] : await readMemberships(db, identity.user_id),
    platform,
    user: { email: identity.email, id: identity.user_id, name: identity.name },
  };
}

/**
 * authorizeTenantAdmin's membership predicate (an active `admin` membership)
 * WITHOUT its shop-status term: every shop is listed with its status.
 */
async function readMemberships(
  db: D1Database,
  userId: string,
): Promise<SessionMembership[]> {
  const rows = await db
    .prepare(
      `SELECT membership.tenant_id, tenant.shop_name, tenant.status, tenant.published
       FROM tenant_memberships AS membership
       INNER JOIN tenants AS tenant ON tenant.tenant_id = membership.tenant_id
       WHERE membership.user_id = ?
         AND membership.role = 'admin'
         AND membership.status = 'active'
       ORDER BY membership.tenant_id
       LIMIT ?`,
    )
    .bind(userId, SESSION_LIST_LIMIT)
    .all<{ published: number; shop_name: string | null; status: string; tenant_id: string }>();

  return rows.results.map((row) => ({
    published: row.published === 1,
    role: "admin",
    shopName: row.shop_name,
    status: row.status,
    tenantId: row.tenant_id,
  }));
}

/**
 * findActiveActingAsGrant's predicate (unrevoked, unexpired, the shop active;
 * the platform identity was checked by the caller), one row per shop with the
 * latest expiry — the grant that request would act under.
 */
async function readOpenGrants(
  db: D1Database,
  userId: string,
  now: number,
): Promise<SessionGrant[]> {
  const rows = await db
    .prepare(
      `SELECT g.tenant_id, tenant.shop_name, MAX(g.expires_at) AS expires_at
       FROM acting_as_grants AS g
       INNER JOIN tenants AS tenant ON tenant.tenant_id = g.tenant_id
       WHERE g.platform_user_id = ?
         AND g.revoked_at IS NULL
         AND g.expires_at > ?
         AND tenant.status = 'active'
       GROUP BY g.tenant_id, tenant.shop_name
       ORDER BY g.tenant_id
       LIMIT ?`,
    )
    .bind(userId, new Date(now).toISOString(), SESSION_LIST_LIMIT)
    .all<{ expires_at: string; shop_name: string | null; tenant_id: string }>();

  return rows.results.map((row) => ({
    expiresAt: row.expires_at,
    shopName: row.shop_name,
    tenantId: row.tenant_id,
  }));
}
