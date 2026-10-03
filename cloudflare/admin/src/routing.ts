import { isAllowedAdminApiRequest } from "./allowlist";

/**
 * Request in, decision out: what the admin Worker does with one request. Pure,
 * so every row of the table in docs/cf-port/CP5_WX_REPORT.md is a test.
 *
 * One tree of addresses for the admin AND the platform console (D102): the
 * application picks the tree (`/platform/*` or the rest), the Worker serves
 * the same shell for both. Decided on the RAW pathname the URL parser gives.
 */

export type AdminRoute =
  /** Forward to the API: `apiPath` is the path after `/_api`; the query travels separately. */
  | { apiPath: string; kind: "api" }
  /** An `/_api` request that is not on the allowlist. */
  | { kind: "api_refused" }
  | { kind: "robots" }
  /** A file of the build; missing ⇒ 404, never the shell. */
  | { kind: "static" }
  /** The application's HTML (every address of either tree). */
  | { kind: "shell" }
  | { kind: "not_found" };

const API_PREFIX = "/_api";
const READ_METHODS = new Set(["GET", "HEAD"]);
const STATIC_PREFIXES = ["/assets/", "/images/"];

/** One top-level segment holding a dot (`/favicon.ico`, `/manifest.json`). */
function isTopLevelFile(pathname: string): boolean {
  const rest = pathname.slice(1);
  return rest.length > 0 && !rest.includes("/") && rest.includes(".");
}

export function classifyAdminRequest(method: string, pathname: string): AdminRoute {
  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
    const apiPath = pathname.slice(API_PREFIX.length);
    return isAllowedAdminApiRequest(method, apiPath)
      ? { apiPath, kind: "api" }
      : { kind: "api_refused" };
  }

  if (!READ_METHODS.has(method)) {
    return { kind: "not_found" };
  }

  if (pathname === "/robots.txt") {
    return { kind: "robots" };
  }

  if (pathname === "/index.html") {
    return { kind: "shell" };
  }

  if (STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || isTopLevelFile(pathname)) {
    return { kind: "static" };
  }

  return { kind: "shell" };
}
