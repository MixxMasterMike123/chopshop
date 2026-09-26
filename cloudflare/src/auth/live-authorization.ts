export interface PlatformPrincipal {
  accountType: "platform_admin";
  userId: string;
}

export interface TenantAdminPrincipal {
  accountType: "tenant_admin";
  role: "admin";
  tenantId: string;
  userId: string;
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
