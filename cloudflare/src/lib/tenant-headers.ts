/**
 * The tenant-header namespace (PLAN §2.1).
 *
 * A tenant is never request-supplied. The storefront tenant is the verified
 * hostname; the admin tenant is an explicit `X-Shop-Id` checked against live
 * memberships. No `X-Tenant-*` header is part of either contract, so both
 * entrypoints strip the whole namespace before routing: a browser, a proxy, or a
 * future forwarding bug in `chopshop-web` cannot introduce one, and no handler
 * written later can be tempted to read one.
 *
 * Matched case-insensitively on the prefix, so `X-Tenant-Id`, `x-tenant-host`
 * and any variant a caller invents are all removed.
 */
const TENANT_HEADER_PATTERN = /^x-tenant-/i;

export function hasTenantHeader(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (TENANT_HEADER_PATTERN.test(name)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns the request with every `X-Tenant-*` header removed.
 *
 * The SAME request object comes back when there is nothing to strip, which is
 * the overwhelmingly common case and keeps the Stripe webhook's raw body on the
 * exact object the runtime delivered. When a copy is needed it is built from the
 * original request, so the method, URL and body stream carry over untouched —
 * the body is moved, never read.
 */
export function stripTenantHeaders(request: Request): Request {
  if (!hasTenantHeader(request.headers)) {
    return request;
  }

  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (TENANT_HEADER_PATTERN.test(name)) {
      headers.delete(name);
    }
  }

  return new Request(request, { headers });
}
