/**
 * The bindings and vars of `chopshop-web` (cloudflare/web/wrangler.jsonc).
 *
 * Declared here, not in the API's `Env`: the two Workers deploy separately and
 * share no binding. The two service shapes are the minimum this Worker calls,
 * so a test can hand in a fake with the same shape.
 */

/** The API's `Internal` entrypoint over the service binding (D77). */
export interface ApiBinding {
  fetch(request: Request): Promise<Response>;
  fetchForShop(shop: string, request: Request): Promise<Response>;
  /**
   * CP14 — where a storefront page should 301 to, or null: `{ shop }` on the
   * shared host, `{ hostname }` for a platform hostname (src/index.ts of the
   * API, `Internal.canonicalShopHost`). Optional so a fake without it is a
   * binding that never redirects.
   */
  canonicalShopHost?(target: { hostname: string } | { shop: string }): Promise<string | null>;
}

/** The static assets of the storefront build (`cloudflare/web/dist`). */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface WebEnv {
  API: ApiBinding;
  ASSETS: AssetsBinding;
  /**
   * The public object origin (D78): images are read from it, so the
   * Content-Security-Policy's image source and the Open Graph image check use
   * it. Absent or not a bare https origin ⇒ no image origin is allowed.
   */
  PUBLIC_OBJECT_BASE_URL: string | undefined;
  /**
   * The shared host's origin, pinned (`pinned.<env>.json → origins.web`). A
   * request on this host names its shop in the first path segment; a request
   * on any other host is a shop's own domain. Absent or malformed ⇒ every
   * request answers 503: the Worker cannot tell which shop a request is for.
   */
  WEB_ORIGIN: string | undefined;
  /**
   * CP14: the base domain of the shops' platform subdomains (the API's var of
   * the same name). Set ⇒ `/<shop>/…` on the shared host 301s to
   * `https://<label>.<base>/…` when the shop has a label, and a platform
   * hostname the shop moved away from 301s to its current one. Absent or not
   * a hostname ⇒ nothing redirects.
   */
  PLATFORM_SHOP_DOMAIN?: string | undefined;
}

export interface WebConfig {
  /** PLATFORM_SHOP_DOMAIN when it is a lowercase hostname; null = no subdomain redirects. */
  platformShopDomain: string | null;
  publicObjectOrigin: string | null;
  webHost: string;
  webOrigin: string;
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

/** One hostname label: the API's rule (src/tenancy/subdomain.ts SUBDOMAIN_LABEL_PATTERN). */
export const HOST_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A lowercase hostname of at least two labels, or null (the API's parsePlatformShopDomain). */
export function platformShopDomain(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 3 || value.length > 200) {
    return null;
  }
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => HOST_LABEL_PATTERN.test(label)) ? value : null;
}

export function readWebConfig(env: WebEnv): WebConfig | null {
  const webOrigin = bareHttpsOrigin(env.WEB_ORIGIN);
  if (webOrigin === null) {
    return null;
  }

  return {
    platformShopDomain: platformShopDomain(env.PLATFORM_SHOP_DOMAIN),
    publicObjectOrigin: bareHttpsOrigin(env.PUBLIC_OBJECT_BASE_URL),
    webHost: new URL(webOrigin).host,
    webOrigin,
  };
}
