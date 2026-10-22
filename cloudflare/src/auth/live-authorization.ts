export interface PlatformPrincipal {
  accountType: "platform_admin";
  userId: string;
}

export interface TenantAdminPrincipal {
  accountType: "tenant_admin";
  /**
   * Present only when a PLATFORM user reached this shop through an acting-as
   * grant (PLAN §2.1) rather than a membership. `userId` is then the platform
   * user's own id — never an impersonated admin — and every mutation that
   * audits records the grant beside it (see auditMetadataJson).
   */
  actingAs?: { grantId: string };
  role: "admin";
  tenantId: string;
  userId: string;
}

/**
 * The `metadata_json` a tenant-admin mutation writes to `audit_events`.
 *
 * Unchanged for a member admin. Under an acting-as grant the grant id is added,
 * so every change a platform user makes inside a shop is traceable to the
 * audited grant that allowed it — the actor column alone would only say WHO,
 * not under which time-boxed permission.
 */
export function auditMetadataJson(
  principal: TenantAdminPrincipal,
  metadata: Record<string, unknown> | null,
): string | null {
  if (principal.actingAs === undefined) {
    return metadata === null ? null : JSON.stringify(metadata);
  }

  return JSON.stringify({
    ...(metadata ?? {}),
    actingAsGrantId: principal.actingAs.grantId,
  });
}

export interface PrintPrincipal {
  accountType: "print_operator";
  tenantId: string;
  userId: string;
}

interface AccessRow {
  account_type: string;
  role?: string;
  tenant_id?: string;
  user_id: string;
}

export async function authorizePlatformAdmin(
  db: D1Database,
  userId: string,
): Promise<PlatformPrincipal | null> {
  const row = await db
    .prepare(
      `SELECT user_id, account_type
       FROM identity_access
       WHERE user_id = ?
         AND account_type = 'platform_admin'
         AND status = 'active'
       LIMIT 1`,
    )
    .bind(userId)
    .first<AccessRow>();

  return row === null
    ? null
    : { accountType: "platform_admin", userId: row.user_id };
}

export async function authorizeTenantAdmin(
  db: D1Database,
  userId: string,
  tenantId: string,
): Promise<TenantAdminPrincipal | null> {
  const row = await db
    .prepare(
      `SELECT access.user_id, access.account_type, membership.tenant_id, membership.role
       FROM identity_access AS access
       INNER JOIN tenant_memberships AS membership
         ON membership.user_id = access.user_id
       INNER JOIN tenants AS tenant
         ON tenant.tenant_id = membership.tenant_id
       WHERE access.user_id = ?
         AND access.account_type = 'tenant_admin'
         AND access.status = 'active'
         AND membership.tenant_id = ?
         AND membership.role = 'admin'
         AND membership.status = 'active'
         AND tenant.status = 'active'
       LIMIT 1`,
    )
    .bind(userId, tenantId)
    .first<AccessRow>();

  return row === null
    ? null
    : {
        accountType: "tenant_admin",
        role: "admin",
        tenantId: row.tenant_id as string,
        userId: row.user_id,
      };
}

export async function authorizePrintOperator(
  db: D1Database,
  userId: string,
  tenantId: string,
): Promise<PrintPrincipal | null> {
  const row = await db
    .prepare(
      `SELECT access.user_id, access.account_type, membership.tenant_id
       FROM identity_access AS access
       INNER JOIN print_memberships AS membership
         ON membership.user_id = access.user_id
       INNER JOIN tenants AS tenant
         ON tenant.tenant_id = membership.tenant_id
       WHERE access.user_id = ?
         AND access.account_type = 'print_operator'
         AND access.status = 'active'
         AND membership.tenant_id = ?
         AND membership.status = 'active'
         AND tenant.status = 'active'
       LIMIT 1`,
    )
    .bind(userId, tenantId)
    .first<AccessRow>();

  return row === null
    ? null
    : {
        accountType: "print_operator",
        tenantId: row.tenant_id as string,
        userId: row.user_id,
      };
}

/**
 * CP13 (design §1.1, A1): an affiliate of ONE shop. `affiliateId` is the
 * `affiliates` row of (tenant, user) — the program row the portal reads and
 * writes. There is no acting-as: a platform user never acts as an affiliate
 * (the shop admin's detail page shows the same projection instead).
 */
export interface AffiliatePrincipal {
  accountType: "affiliate";
  affiliateId: string;
  tenantId: string;
  userId: string;
}

/**
 * The affiliate guard's decision, live on every request like the others: an
 * ACTIVE identity of kind 'affiliate', an ACTIVE membership of role
 * 'affiliate' in this shop, the shop active, and the shop's affiliates row of
 * this person. The program status (active/inactive/suspended) is NOT read:
 * it gates the money paths, never the login (design §3.1: reversals, the
 * ledger and payouts ignore it; "Ta bort" revokes the membership instead).
 */
export async function authorizeAffiliate(
  db: D1Database,
  userId: string,
  tenantId: string,
): Promise<AffiliatePrincipal | null> {
  const row = await db
    .prepare(
      `SELECT access.user_id, affiliate.affiliate_id, membership.tenant_id
       FROM identity_access AS access
       INNER JOIN tenant_memberships AS membership
         ON membership.user_id = access.user_id
       INNER JOIN tenants AS tenant
         ON tenant.tenant_id = membership.tenant_id
       INNER JOIN affiliates AS affiliate
         ON affiliate.tenant_id = membership.tenant_id
        AND affiliate.user_id = access.user_id
       WHERE access.user_id = ?
         AND access.account_type = 'affiliate'
         AND access.status = 'active'
         AND membership.tenant_id = ?
         AND membership.role = 'affiliate'
         AND membership.status = 'active'
         AND tenant.status = 'active'
       LIMIT 1`,
    )
    .bind(userId, tenantId)
    .first<{ affiliate_id: string; tenant_id: string; user_id: string }>();

  return row === null
    ? null
    : {
        accountType: "affiliate",
        affiliateId: row.affiliate_id,
        tenantId: row.tenant_id,
        userId: row.user_id,
      };
}
