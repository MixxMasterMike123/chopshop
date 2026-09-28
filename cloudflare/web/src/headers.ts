/**
 * The headers every answer of this Worker carries (brief E rule 5): the
 * storefront target's security headers of firebase.json, and its
 * Content-Security-Policy in report-only mode with two changes — the Firebase
 * and Google endpoints are gone (the storefront talks to its own origin only,
 * through `/_api`), and images may come from this origin and the public object
 * origin, nothing else (D92: public images are served from an address of
 * their own).
 */

export function contentSecurityPolicy(publicObjectOrigin: string | null): string {
  const images = ["'self'", "data:", "blob:", ...(publicObjectOrigin === null ? [] : [publicObjectOrigin])];
  return [
    "default-src 'self'",
    "script-src 'self' https://js.stripe.com https://widget.trustpilot.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `img-src ${images.join(" ")}`,
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https://api.stripe.com",
    "frame-src https://js.stripe.com https://hooks.stripe.com https://widget.trustpilot.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export function securityHeaders(publicObjectOrigin: string | null): Record<string, string> {
  return {
    "Content-Security-Policy-Report-Only": contentSecurityPolicy(publicObjectOrigin),
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

/** The response with the security headers set (a new Response; bodies move). */
export function withSecurityHeaders(
  response: Response,
  publicObjectOrigin: string | null,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders(publicObjectOrigin))) {
    headers.set(name, value);
  }
  return new Response(
    response.status === 304 || response.status === 204 ? null : response.body,
    { headers, status: response.status, statusText: response.statusText },
  );
}
