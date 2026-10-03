/**
 * The bindings and vars of `chopshop-admin` (cloudflare/admin/wrangler.jsonc).
 *
 * Declared here, not in the API's `Env`: the Workers deploy separately and
 * share no binding. The two binding shapes are the minimum this Worker calls,
 * so a test can hand in a fake with the same shape.
 */

/** The API's `Internal` entrypoint over the service binding (CP5 brief WX). */
export interface ApiBinding {
  fetch(request: Request): Promise<Response>;
}

/** The static files of the admin build (`cloudflare/admin/dist`). */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface AdminEnv {
  API: ApiBinding;
  ASSETS: AssetsBinding;
  /**
   * The admin host's origin, pinned (`pinned.<env>.json → origins.admin`).
   * The Worker answers on this host only: the session cookie is host-only to
   * it, and the API's Better Auth trusts it (`AUTH_TRUSTED_ORIGINS`). Absent or
   * malformed ⇒ every request answers 503.
   */
  ADMIN_ORIGIN: string | undefined;
  /**
   * The public object origin (D78): product and branding images are read from
   * it, so the Content-Security-Policy's image source names it. Absent or not
   * a bare https origin ⇒ no such image origin is allowed.
   */
  PUBLIC_OBJECT_BASE_URL: string | undefined;
}

export interface AdminConfig {
  adminHost: string;
  adminOrigin: string;
  publicObjectOrigin: string | null;
}

/** A bare https origin (scheme, host, optional port; nothing else), or null. */
export function bareHttpsOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  // `url.origin === value` refuses a path (even "/"), a query, a fragment,
  // credentials, a default port spelled out and any non-canonical host.
  return url.protocol === "https:" && url.origin === value ? url.origin : null;
}

export function readAdminConfig(env: AdminEnv): AdminConfig | null {
  const adminOrigin = bareHttpsOrigin(env.ADMIN_ORIGIN);
  if (adminOrigin === null) {
    return null;
  }

  return {
    adminHost: new URL(adminOrigin).host,
    adminOrigin,
    publicObjectOrigin: bareHttpsOrigin(env.PUBLIC_OBJECT_BASE_URL),
  };
}
