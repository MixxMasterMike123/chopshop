/**
 * THE ALLOWLIST of API routes a browser may reach through the admin Worker
 * (CP5 brief WX rule 3).
 *
 * A request passes only when its method and its RAW path (the part after
 * `/_api`) match one family below. Nothing else passes: no storefront route,
 * no webhook, no render, staging or health route, and no Better Auth endpoint
 * the API does not mount. It is an allowlist of what passes, never a denylist.
 *
 *   - `/v1/admin/<one or more segments>`    GET HEAD POST PUT PATCH DELETE
 *   - `/v1/platform/<one or more segments>` the same, EXCEPT `/v1/platform/bootstrap`:
 *     the one-time operator call authenticated by `X-Bootstrap-Token` (src/platform/bootstrap.ts)
 *     is never a browser's, and that header is not forwarded anyway;
 *   - `GET /v1/me` exactly (unit WA);
 *   - the Better Auth routes the API mounts, method and path exactly as
 *     src/auth/auth-routes.ts lists them (sign-up and every other endpoint stay
 *     out there and here).
 *
 * Decided on the RAW pathname, as the API routes on it (src/app.ts, "ROUTING IS
 * ON THE RAW PATHNAME"). Before any family is matched the path must be CLEAN:
 * no empty segment (so no `//` and no trailing slash), no backslash, and every
 * segment made only of unreserved characters, sub-delimiters, `:` `@` and
 * percent escapes; decoded once, a segment must not be `.` or `..` and must
 * hold no `/` (an encoded slash), no `\` and no control character. The URL
 * parser has already resolved literal and `%2e` dot segments before this runs;
 * this is the second fence. A literal segment of a family matches only its
 * exact spelling (`%61dmin` is not `admin`).
 */

const PREFIX_METHODS: ReadonlySet<string> = new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);

const PREFIX_FAMILIES: readonly (readonly string[])[] = [
  ["v1", "admin"],
  ["v1", "platform"],
];

/** Exact `METHOD /path` rows (raw path after `/_api`). */
const EXACT_ROUTES: ReadonlySet<string> = new Set([
  "GET /v1/me",
  // src/auth/auth-routes.ts ALLOWED_AUTH_ROUTES
  "GET /api/auth/get-session",
  "POST /api/auth/sign-in/email",
  "POST /api/auth/sign-out",
  // src/auth/auth-routes.ts, the password reset (mounted while its delivery is configured)
  "POST /api/auth/request-password-reset",
  "POST /api/auth/reset-password",
]);

/** The emailed reset link, as src/auth/auth-routes.ts RESET_LINK_PATH matches it. */
const RESET_LINK_PATH = /^\/api\/auth\/reset-password\/[A-Za-z0-9_-]{16,128}$/;

const REFUSED_EXACT_PATHS: ReadonlySet<string> = new Set(["/v1/platform/bootstrap"]);

// RFC 3986 pchar: unreserved, sub-delims, ":" and "@", or a percent escape.
const RAW_SEGMENT = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+$/;
const MAX_SEGMENT_LENGTH = 512;
const MAX_PATH_LENGTH = 2048;
const FORBIDDEN_DECODED = /[/\\\u0000-\u001f\u007f]/;

function isCleanSegment(raw: string): boolean {
  if (raw.length > MAX_SEGMENT_LENGTH || !RAW_SEGMENT.test(raw)) {
    return false;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return false;
  }

  return decoded !== "." && decoded !== ".." && !FORBIDDEN_DECODED.test(decoded);
}

/**
 * The raw path's segments when the path is clean, else null. `rawPath` starts
 * with "/" (a pathname as the URL parser gives it).
 */
export function cleanSegments(rawPath: string): string[] | null {
  if (!rawPath.startsWith("/") || rawPath.length > MAX_PATH_LENGTH || rawPath.includes("\\")) {
    return null;
  }

  const segments = rawPath.slice(1).split("/");
  return segments.every(isCleanSegment) ? segments : null;
}

/** Whether `(method, rawPath)` may be forwarded to the API. */
export function isAllowedAdminApiRequest(method: string, rawPath: string): boolean {
  const segments = cleanSegments(rawPath);
  if (segments === null || REFUSED_EXACT_PATHS.has(rawPath)) {
    return false;
  }

  if (EXACT_ROUTES.has(`${method} ${rawPath}`)) {
    return true;
  }
  if (method === "GET" && RESET_LINK_PATH.test(rawPath)) {
    return true;
  }

  return (
    PREFIX_METHODS.has(method) &&
    PREFIX_FAMILIES.some(
      (family) =>
        segments.length > family.length &&
        family.every((expected, index) => segments[index] === expected),
    )
  );
}
