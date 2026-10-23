import { HOST_LABEL_PATTERN } from "./env";
import type { Site } from "./routing";

/**
 * CP14 — the shops' platform subdomains, as this Worker sees them: which
 * question to ask the API about a storefront page, and the 301 its answer
 * gives. Pure; the API holds the labels (src/tenancy/subdomain.ts), and only
 * a hostname under the configured base is ever followed.
 */

export type SubdomainTarget = { hostname: string } | { shop: string };

export interface SubdomainQuestion {
  /** The path the redirect keeps: on the shared host, without `/<shop>`. */
  path: string;
  target: SubdomainTarget;
}

/**
 * Storefront paths (relative to `<root>`) that are NEVER moved to another
 * origin, on the shared host's `/<shop>/…` form or on a retired host: the
 * buying flow keeps its state in origin-scoped browser storage, so a 301 to
 * the subdomain would lose it (Codex P1 on b7a1112d).
 *   /cart, /checkout          the cart (src/storefront/providers/Cart.jsx, localStorage)
 *   /order-return             where Stripe returns a redirect-based payment
 *                             (StripePaymentForm.jsx `return_url` = this origin);
 *                             the pending checkout id is in sessionStorage
 *                             (src/api/orders.js)
 *   /order-confirmation/…     the receipt token is in sessionStorage (src/api/orders.js)
 * They are served where they arrive for as long as that host resolves (a
 * retired host: its grace period).
 */
export const NO_SUBDOMAIN_REDIRECT_PATHS: readonly string[] = [
  "/cart",
  "/checkout",
  "/order-return",
  "/order-confirmation",
];

function isBuyingFlowPath(path: string): boolean {
  return NO_SUBDOMAIN_REDIRECT_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** The label of `hostname` when it is exactly one label under `base`, else null. */
export function labelUnder(hostname: string, base: string): string | null {
  const suffix = `.${base}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }
  const label = hostname.slice(0, -suffix.length);
  return HOST_LABEL_PATTERN.test(label) ? label : null;
}

/**
 * What to ask, or null when no subdomain redirect can apply here:
 *   - the shared host's `/<shop>/…` → `{ shop }`, the path without `/<shop>`;
 *   - a host one label under the base → `{ hostname }`, the path as it is;
 *   - anything else (the feature off, a shop's own domain, a host with a
 *     port, a path of the buying flow: NO_SUBDOMAIN_REDIRECT_PATHS) → null.
 */
export function subdomainQuestion(base: string | null, url: URL, site: Site): SubdomainQuestion | null {
  if (base === null || url.port !== "") {
    return null;
  }
  if (site.shop !== null) {
    const path = url.pathname.slice(site.root.length) || "/";
    return isBuyingFlowPath(path) ? null : { path, target: { shop: site.shop } };
  }
  return labelUnder(url.hostname, base) === null || isBuyingFlowPath(url.pathname)
    ? null
    : { path: url.pathname, target: { hostname: url.hostname } };
}

/**
 * The Location of the 301, or null (serve the page where it is): the API's
 * answer must be a hostname one label under the base and not this host; the
 * path and the query are kept byte for byte.
 */
export function subdomainLocation(
  base: string,
  answer: unknown,
  url: URL,
  path: string,
): string | null {
  if (typeof answer !== "string" || labelUnder(answer, base) === null || answer === url.hostname) {
    return null;
  }
  return `https://${answer}${path}${url.search}`;
}
