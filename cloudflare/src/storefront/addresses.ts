/**
 * THE address grammar (CP4_BRIEFS.md "The address grammar"): the slug rule
 * and the paths of the storefront's pages. Every module that writes a
 * storefront address takes it from here.
 *
 * Every address the API returns in a body is a path RELATIVE TO THE SHOP'S
 * ROOT, encoded segment by segment; the web Worker and the client put the root
 * in front. The API never builds an absolute storefront address.
 */

export const HOME_PATH = "/";
export const ALL_PRODUCTS_PATH = "/produkter";

/**
 * One segment of a path, percent-encoded for an address: encodeURIComponent
 * plus `!'()*` (the web Worker and the client use the same rule). The result
 * holds only `A-Z a-z 0-9 - . _ ~ %`.
 */
export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The source system's `slugify` (src/utils/productUrls.js), byte for byte:
 * lowercase, trim, whitespace → "-", å/ä → a, ö → o, & → "-and-", every other
 * character outside [A-Za-z0-9_-] dropped, runs of "-" collapsed. It builds
 * every storefront address that carries a name: a product's handle, a
 * category's `/kategori/<key>`, a tag's `/tagg/<key>` (the keys of 0040
 * `products.category_key` and `product_tags.tag_key`), a collection's handle.
 * The pages find a category or a tag again by slugifying the real names and
 * comparing. The importer applies the same function (the pinned vectors are
 * in test/admin-products.test.ts and test/addresses.test.ts).
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/&/g, "-and-")
    .replace(/[^\w-]+/g, "")
    .replace(/--+/g, "-");
}

/** A product: `/product/<handle>`, the handle as ONE encoded segment. */
export function productPath(handle: string): string {
  return `/product/${encodePathSegment(handle)}`;
}

/** A collection: `/samling/<handle>`. */
export function collectionPath(handle: string): string {
  return `/samling/${encodePathSegment(handle)}`;
}

/** A category: `/kategori/<slug>`; null when the name slugifies to nothing (no address can name it). */
export function categoryPath(category: string): string | null {
  const slug = slugify(category);
  return slug.length === 0 ? null : `/kategori/${encodePathSegment(slug)}`;
}

/** A tag: `/tagg/<slug>`; null when the tag slugifies to nothing. */
export function tagPath(tag: string): string | null {
  const slug = slugify(tag);
  return slug.length === 0 ? null : `/tagg/${encodePathSegment(slug)}`;
}

/**
 * A content page or post: `<root>/<slug>`, the slug as one encoded segment.
 * src/content/pages.ts keeps a `pagePath` of its own that does not encode:
 * the two agree on every slug the pages table admits (`[a-z0-9-]`) and on
 * nothing else (test/addresses.test.ts).
 */
export function pagePath(slug: string): string {
  return `/${encodePathSegment(slug)}`;
}
