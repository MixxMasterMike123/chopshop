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
}

export interface WebConfig {
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

export function readWebConfig(env: WebEnv): WebConfig | null {
  const webOrigin = bareHttpsOrigin(env.WEB_ORIGIN);
  if (webOrigin === null) {
    return null;
  }

  return {
    publicObjectOrigin: bareHttpsOrigin(env.PUBLIC_OBJECT_BASE_URL),
    webHost: new URL(webOrigin).host,
    webOrigin,
  };
}
