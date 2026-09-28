import { isAllowedStorefrontApiRequest } from "./api-allowlist";
import { parseShopSegment } from "./shop-segment";

/**
 * Request in, decision out: what this Worker does with one request. Pure, so
 * every rule of the table in docs/cf-port/CP4_E_REPORT.md is a test.
 *
 * `<root>` is `/<shop>` on the shared host (D77) and empty on a shop's own
 * domain (the address grammar, CP4_BRIEFS.md). Everything is decided on the
 * RAW pathname the URL parser gives.
 */

export interface Site {
  /** "/<shop>" on the shared host, "" on a shop's own domain. */
  root: string;
  /** The shop segment on the shared host; null on a shop's own domain. */
  shop: string | null;
}

export type WebRoute =
  /** Forward to the API: `apiPath` is `/v1/…`, the query travels separately. */
  | { apiPath: string; kind: "api"; site: Site }
  /** An `/_api` request that is not on the allowlist, or names no shop. */
  | { kind: "api_refused" }
  | { kind: "robots" }
  | { kind: "sitemap"; site: Site }
  /**
   * A file of the build. When the build has no such file and the path could
   * be a storefront page, `orPage` is that page.
   */
  | { kind: "static"; orPage: { relativePath: string; site: Site } | null }
  /** A storefront address: the app, with the head of `relativePath`. */
  | { kind: "page"; relativePath: string; site: Site }
  /** The shared host without a valid shop: the app, as a 404. */
  | { kind: "no_shop" }
  | { kind: "not_found" };

const API_PREFIX = "/_api";
const READ_METHODS = new Set(["GET", "HEAD"]);
const STATIC_PREFIXES = ["/assets/", "/images/"];
const SHELL_PATH = "/index.html";

/** One top-level segment holding a dot (`/favicon.ico`, `/manifest.json`). */
function isTopLevelFile(pathname: string): boolean {
  const rest = pathname.slice(1);
  return rest.length > 0 && !rest.includes("/") && rest.includes(".");
}

function isStaticPath(pathname: string): boolean {
  return (
    pathname !== SHELL_PATH &&
    (STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
      isTopLevelFile(pathname))
  );
}

function classifyApi(method: string, pathname: string, shared: boolean): WebRoute {
  const rest = pathname.slice(API_PREFIX.length);
  if (!shared) {
    return isAllowedStorefrontApiRequest(method, rest)
      ? { apiPath: rest, kind: "api", site: { root: "", shop: null } }
      : { kind: "api_refused" };
  }

  // "/<shop>/v1/…" after the prefix.
  const slash = rest.indexOf("/", 1);
  if (!rest.startsWith("/") || slash === -1) {
    return { kind: "api_refused" };
  }
  const shop = parseShopSegment(rest.slice(1, slash));
  const apiPath = rest.slice(slash);
  if (shop === null || !isAllowedStorefrontApiRequest(method, apiPath)) {
    return { kind: "api_refused" };
  }
  return { apiPath, kind: "api", site: { root: `/${shop}`, shop } };
}

export function classifyRequest(
  method: string,
  pathname: string,
  shared: boolean,
): WebRoute {
  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
    return classifyApi(method, pathname, shared);
  }

  if (!READ_METHODS.has(method)) {
    return { kind: "not_found" };
  }

  if (pathname === "/robots.txt") {
    return { kind: "robots" };
  }

  if (!shared) {
    const site: Site = { root: "", shop: null };
    if (pathname === "/sitemap.xml") {
      return { kind: "sitemap", site };
    }
    if (isStaticPath(pathname)) {
      return { kind: "static", orPage: { relativePath: pathname, site } };
    }
    return { kind: "page", relativePath: pathname, site };
  }

  if (isStaticPath(pathname)) {
    return { kind: "static", orPage: null };
  }

  const slash = pathname.indexOf("/", 1);
  const first = slash === -1 ? pathname.slice(1) : pathname.slice(1, slash);
  const shop = parseShopSegment(first);
  if (shop === null) {
    return { kind: "no_shop" };
  }

  const site: Site = { root: `/${shop}`, shop };
  const relative = slash === -1 ? "/" : pathname.slice(slash);
  if (relative === "/sitemap.xml") {
    return { kind: "sitemap", site };
  }
  return { kind: "page", relativePath: relative, site };
}
