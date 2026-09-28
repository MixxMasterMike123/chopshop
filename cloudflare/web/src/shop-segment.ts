/**
 * Which shop a shared-host path names (D77, CP4 brief E rule 1).
 *
 * The first path segment is the shop when it has the shape of a shop id and is
 * not a reserved first segment. The shape is the API's own
 * (`SHOP_SEGMENT_PATTERN` in src/tenancy/shop-hostname.ts); a test keeps the
 * two equal. The segment is tested RAW: a percent-encoded or mixed-case
 * spelling of a shop is not that shop.
 */
export const SHOP_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * `NON_SHOP_FIRST_SEGMENTS` of src/config/tenancy.js, verbatim. A test keeps
 * the two lists equal, so the storefront and this Worker agree on what is not
 * a shop.
 */
export const TENANCY_RESERVED_SEGMENTS: readonly string[] = [
  "se",
  "gb",
  "us",
  "login",
  "register",
  "forgot-password",
  "reset-password",
  "affiliate-login",
  "__",
  "account",
  "admin",
  "platform",
];

/**
 * This Worker's own top-level paths that have the shape of a shop id: the
 * build's hashed files and its images. (`_api`, `robots.txt` and the files
 * with a dot never match the shape.)
 */
export const WORKER_RESERVED_SEGMENTS: readonly string[] = ["assets", "images"];

const RESERVED = new Set<string>([
  ...TENANCY_RESERVED_SEGMENTS,
  ...WORKER_RESERVED_SEGMENTS,
]);

export function parseShopSegment(raw: string | undefined): string | null {
  if (raw === undefined || !SHOP_SEGMENT_PATTERN.test(raw) || RESERVED.has(raw)) {
    return null;
  }

  return raw;
}
