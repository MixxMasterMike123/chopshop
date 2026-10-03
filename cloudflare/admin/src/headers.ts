/**
 * The headers of the admin Worker's answers (CP5 brief WX rule 4).
 *
 * Every answer: `X-Robots-Tag: noindex, nofollow` (no admin address is ever
 * indexed), `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`,
 * HSTS. An HTML answer also carries the ENFORCED Content-Security-Policy below
 * (not report-only: the admin build is ours, and the session lives here),
 * `X-Frame-Options: DENY` and a Permissions-Policy.
 *
 * The policy, source by source:
 *   - scripts only from this origin; no Stripe script (no admin page embeds
 *     Stripe: onboarding and the dashboard are redirects), so `frame-src 'none'`;
 *   - styles from this origin and inline (`'unsafe-inline'`: the rich-text
 *     editor writes style attributes), plus Google Fonts' stylesheet host,
 *     because the source system's HTML loads the admin font (Figtree) from it
 *     and the shop-template preview injects the template's fonts from it
 *     (src/config/nordTokens.js ensureTemplateFonts); font files from this
 *     origin, `data:` and Google Fonts' file host;
 *   - images from this origin, `data:`, `blob:` (local previews of a file
 *     before upload), the public object origin (D78) and the private bucket's
 *     presigned S3 host (artwork previews, `*.r2.cloudflarestorage.com`, which
 *     also covers the EU jurisdiction's `<account>.eu.r2…`);
 *   - connections to this origin (`/_api`) and the presigned S3 host;
 *   - `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`,
 *     `object-src 'none'`.
 */

const R2_S3_HOSTS = "https://*.r2.cloudflarestorage.com";
const FONT_STYLESHEETS = "https://fonts.googleapis.com";
const FONT_FILES = "https://fonts.gstatic.com";

export function contentSecurityPolicy(publicObjectOrigin: string | null): string {
  const images = [
    "'self'",
    "data:",
    "blob:",
    ...(publicObjectOrigin === null ? [] : [publicObjectOrigin]),
    R2_S3_HOSTS,
  ];
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-inline' ${FONT_STYLESHEETS}`,
    `img-src ${images.join(" ")}`,
    `font-src 'self' data: ${FONT_FILES}`,
    `connect-src 'self' ${R2_S3_HOSTS}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const EVERY_ANSWER: Readonly<Record<string, string>> = {
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

function isHtml(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");
}

/** The response with the admin's headers set (a new Response; the body moves). */
export function withAdminHeaders(response: Response, publicObjectOrigin: string | null): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(EVERY_ANSWER)) {
    headers.set(name, value);
  }
  if (isHtml(response)) {
    headers.set("Content-Security-Policy", contentSecurityPolicy(publicObjectOrigin));
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    headers.set("X-Frame-Options", "DENY");
  }
  return new Response(
    response.status === 304 || response.status === 204 ? null : response.body,
    { headers, status: response.status, statusText: response.statusText },
  );
}
