export interface TenantContext {
  domainKind: string;
  hostname: string;
  tenantId: string;
}

interface TenantRow {
  domain_kind: string;
  hostname: string;
  tenant_id: string;
}

function requestHostname(request: Request): string | null {
  const url = new URL(request.url);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return hostname.length > 0 ? hostname : null;
}

export async function resolveRequestTenant(
  db: D1Database,
  request: Request,
): Promise<TenantContext | null> {
  const hostname = requestHostname(request);
  if (hostname === null) {
    return null;
  }

  const row = await db
    .prepare(
      `SELECT
         domain.kind AS domain_kind,
         domain.hostname,
         domain.tenant_id
       FROM tenant_domains AS domain
       INNER JOIN tenants AS tenant
         ON tenant.tenant_id = domain.tenant_id
       WHERE domain.hostname = ?
         AND domain.status = 'verified'
         AND tenant.status = 'active'
       LIMIT 1`,
    )
    .bind(hostname)
    .first<TenantRow>();

  if (row === null) {
    return null;
  }

  return {
    domainKind: row.domain_kind,
    hostname: row.hostname,
    tenantId: row.tenant_id,
  };
}
