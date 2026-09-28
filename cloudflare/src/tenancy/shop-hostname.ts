/**
 * D77 — the shop named in a storefront path, mapped to the hostname the API
 * already resolves tenants from.
 *
 * The browser keeps today's addresses (`/<shop>/cart` on the shared host), and
 * the API keeps ONE tenant rule: the verified hostname (resolve-tenant.ts). The
 * web Worker reads the first path segment and calls `Internal.fetchForShop`,
 * which asks this module for that shop's storefront hostname and routes the
 * request as if it had arrived on it. A browser still cannot name a tenant to
 * the API: `fetchForShop` is reachable only over the service binding, and the
 * answer is a hostname that `resolveRequestTenant` then checks again.
 *
 * Answers a hostname only when ALL of these hold, else null:
 *   - the segment is a well-formed shop id (checked before any query);
 *   - the tenant exists and is `active`;
 *   - it has a domain of kind `storefront` with status `verified`.
 * Several such domains: the lowest hostname, so the answer is stable.
 */

/** The shape of a shop segment: the same rule the web Worker applies. */
export const SHOP_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isShopSegment(value: string): boolean {
  return SHOP_SEGMENT_PATTERN.test(value);
}

export async function shopStorefrontHostname(
  db: D1Database,
  shop: string,
): Promise<string | null> {
  if (!isShopSegment(shop)) {
    return null;
  }

  const row = await db
    .prepare(
      `SELECT domain.hostname
       FROM tenant_domains AS domain
       INNER JOIN tenants AS tenant
         ON tenant.tenant_id = domain.tenant_id
       WHERE domain.tenant_id = ?
         AND domain.kind = 'storefront'
         AND domain.status = 'verified'
         AND tenant.status = 'active'
       ORDER BY domain.hostname ASC
       LIMIT 1`,
    )
    .bind(shop)
    .first<{ hostname: string }>();

  return row === null ? null : row.hostname;
}

/**
 * The request as if it had arrived on `hostname`: same method, headers, body
 * and RAW path and query; only the host changes (https, no port). Null when the
 * URL setter would not take the value, so a hostname the URL grammar refuses
 * can never leave the request on the caller's own host.
 */
export function requestOnHostname(request: Request, hostname: string): Request | null {
  const url = new URL(request.url);
  url.protocol = "https:";
  url.port = "";
  url.hostname = hostname;
  if (url.hostname !== hostname) {
    return null;
  }

  return new Request(url.toString(), request);
}
