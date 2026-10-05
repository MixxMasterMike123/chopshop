/**
 * THE ALLOWLIST of API routes a browser may reach through this Worker
 * (CP4 brief E rule 2).
 *
 * A request passes only when its method and its RAW path match one row below,
 * segment by segment. Nothing else passes: not the admin, platform, render,
 * webhook or staging surfaces, not the auth namespace, and not a route that
 * is added to the API later until a row is added here. It is an allowlist of
 * what passes, never a denylist of what does not.
 *
 * Decided on the RAW pathname, as the API routes on it (src/app.ts, "ROUTING
 * IS ON THE RAW PATHNAME"): a literal segment matches only its exact spelling,
 * so `%70roducts`, `Products` or `products;x` are not `products`. An id
 * segment is unreserved characters and percent escapes only, is decoded once
 * to check it, and is refused when the decoding fails or yields a dot segment,
 * a slash, a backslash or a control character. The URL parser has already
 * resolved literal and `%2e` dot segments before this runs; the id rule is the
 * second fence.
 *
 * Sources of the rows: the routes that exist (src/app.ts: storefront,
 * products, pod previews, checkout, payment, receipt, orders, reports, the
 * withdrawal function, the two links of an abandoned-checkout reminder) and the
 * public routes of CP4 briefs A–C (collections, pages, legal). `GET /v1/seo`
 * and `GET /v1/sitemap` are NOT here: only this Worker calls them, never a
 * browser.
 */

const ID = ":id";

interface ApiRoute {
  readonly methods: readonly string[];
  readonly segments: readonly string[];
}

export const STOREFRONT_API_ROUTES: readonly ApiRoute[] = [
  { methods: ["GET"], segments: ["v1", "storefront"] },
  { methods: ["GET"], segments: ["v1", "storefront", "pod-previews", ID, ID] },
  { methods: ["GET"], segments: ["v1", "products"] },
  { methods: ["GET"], segments: ["v1", "products", ID] },
  { methods: ["GET"], segments: ["v1", "collections"] },
  { methods: ["GET"], segments: ["v1", "collections", ID] },
  { methods: ["GET"], segments: ["v1", "pages"] },
  { methods: ["GET"], segments: ["v1", "pages", ID] },
  { methods: ["GET"], segments: ["v1", "legal"] },
  { methods: ["GET"], segments: ["v1", "legal", ID] },
  { methods: ["POST"], segments: ["v1", "checkout"] },
  { methods: ["POST"], segments: ["v1", "checkout", ID, "payment"] },
  { methods: ["POST"], segments: ["v1", "checkout", ID, "receipt"] },
  { methods: ["POST"], segments: ["v1", "discount-codes", "preview"] },
  { methods: ["GET"], segments: ["v1", "orders", ID] },
  { methods: ["POST"], segments: ["v1", "reports"] },
  { methods: ["POST"], segments: ["v1", "withdrawals"] },
  // CP9-AC: the reminder's resume link and its unsubscribe (also the
  // mail's RFC 8058 one-click target). The token is unreserved characters only.
  { methods: ["POST"], segments: ["v1", "checkout-recovery", ID] },
  { methods: ["POST"], segments: ["v1", "checkout-recovery", ID, "unsubscribe"] },
];

const RAW_ID_SEGMENT = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/;
const MAX_ID_SEGMENT_LENGTH = 512;
const FORBIDDEN_DECODED = /[/\\\u0000-\u001f\u007f]/;

export function isIdSegment(raw: string): boolean {
  if (raw.length > MAX_ID_SEGMENT_LENGTH || !RAW_ID_SEGMENT.test(raw)) {
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

/** `rawPath` is a pathname as the URL parser gives it, starting with "/". */
export function isAllowedStorefrontApiRequest(method: string, rawPath: string): boolean {
  if (!rawPath.startsWith("/")) {
    return false;
  }

  const segments = rawPath.slice(1).split("/");
  return STOREFRONT_API_ROUTES.some(
    (route) =>
      route.methods.includes(method) &&
      route.segments.length === segments.length &&
      route.segments.every((expected, index) => {
        const actual = segments[index] ?? "";
        return expected === ID ? isIdSegment(actual) : actual === expected;
      }),
  );
}
