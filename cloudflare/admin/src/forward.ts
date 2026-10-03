/**
 * The request the admin Worker hands the API, and what it does to the answer
 * (CP5 brief WX rule 2).
 *
 * The forwarded request is BUILT, not copied: only the headers named in
 * FORWARDED_HEADERS go on, every other header the browser sent stays here.
 * That is what makes "no header a browser could forge reaches the API" true by
 * construction rather than by a list of what to drop: no `X-Tenant-*`, no
 * `X-Bootstrap-Token`, no `Authorization`, no `X-Storefront-Preview`, no
 * `Stripe-Signature`, no `X-Forwarded-*`, and nothing invented later.
 *
 * Its URL keeps the browser's scheme and host (the admin host): the API's
 * `isSameOriginRequest` compares `Origin` with the request URL's origin, so a
 * same-origin request stays same-origin and a cross-origin one stays
 * cross-origin. The proxy never vouches for anything.
 *
 * `CF-Connecting-IP` is the visitor's address as the edge gave it to THIS
 * Worker (the edge overwrites whatever a browser sends), so the API's rate
 * limits and Better Auth's limiter count the visitor, as the web Worker does.
 *
 * A body goes on only when there is one, as a stream (never read here): a
 * method that carries none, or a request that declares `Content-Length: 0`,
 * goes with no body and no `Content-Length`.
 */

export const FORWARDED_HEADERS: readonly string[] = [
  "accept",
  "cf-connecting-ip",
  "content-length",
  "content-type",
  // The session (Better Auth's cookie, host-only to the admin host).
  "cookie",
  "idempotency-key",
  "if-none-match",
  "origin",
  // Better Auth's sign-in CSRF guard reads the Fetch Metadata headers
  // (validateFormCsrf); a browser sets them and a page's script cannot.
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  // The platform-terms acceptance records it as evidence (src/routes/legal-admin.ts).
  "user-agent",
  "x-shop-id",
];

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
// A Response with one of these statuses must be built with a null body.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export function forwardedAdminRequest(request: Request, target: string): Request {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  const sendsBody =
    !BODYLESS_METHODS.has(request.method) &&
    request.body !== null &&
    request.headers.get("content-length") !== "0";
  if (!sendsBody) {
    headers.delete("content-length");
  }

  return new Request(target, {
    body: sendsBody ? request.body : null,
    headers,
    method: request.method,
    redirect: "manual",
  });
}

/**
 * The API's answer as the browser gets it: status, body and every header
 * untouched — `Set-Cookie` included, each cookie as the API set it (Better
 * Auth's session cookie carries no `Domain`, so the browser keeps it for the
 * admin host only).
 */
export function apiResponseForBrowser(response: Response): Response {
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : response.body, {
    headers: new Headers(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
}
