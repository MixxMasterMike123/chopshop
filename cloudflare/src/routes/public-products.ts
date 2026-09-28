import type { DisplayCursor } from "../catalog/admin-product-reads";
import { decodeDisplayCursor } from "../catalog/admin-product-reads";
import type { PublicProductFilter } from "../catalog/public-catalog";
import {
  getPublicProductByRefVersioned,
  listPublicProductPageVersioned,
  PUBLIC_PRODUCT_LIMIT,
} from "../catalog/public-catalog";
import { decodeSegment, invalidRequestResponse, notFoundResponse } from "../lib/responses";
import { versionedJsonResponse } from "../storefront/public-routes";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

/**
 * CP4-A — the two public product reads (tenant by hostname; ETag =
 * catalog_version, 304 on If-None-Match):
 *
 *   GET /v1/products?tag&category&featured=1&cursor&limit   { products, nextCursor }
 *   GET /v1/products/:ref                                   { product }
 *
 * `:ref` is the product's id, its handle or the source system's sku rule
 * (public-catalog.ts getPublicProductByRef). The segment is read from the RAW
 * pathname and decoded once (see ACTING_AS_ROUTE); a ref is 1–1200
 * characters with no "/".
 */

export const PUBLIC_PRODUCTS_PATH = "/v1/products";
export const PUBLIC_PRODUCT_ROUTE = "/v1/products/:ref";

// "", "v1", "products", :ref
const REF_SEGMENT = 3;
/** A handle is at most 1200 characters (migrations/0040); a ref is an id or a handle. */
const REF_MAX_LENGTH = 1_200;
const TAG_KEY_MAX_LENGTH = 250;
const CATEGORY_KEY_MAX_LENGTH = 500;

function refSegment(request: Request): string | null {
  const raw = new URL(request.url).pathname.split("/")[REF_SEGMENT] ?? "";
  const decoded = decodeSegment(raw);
  return decoded === null || decoded.length > REF_MAX_LENGTH ? null : decoded;
}

/** `GET /v1/products` query → a filter, or null (400). Unknown or repeated parameters are refused. */
export function parsePublicProductListQuery(url: URL): PublicProductFilter | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (
      !["category", "cursor", "featured", "limit", "tag"].includes(key) ||
      params.getAll(key).length > 1
    ) {
      return null;
    }
  }
  const limitRaw = params.get("limit");
  if (limitRaw !== null && !/^\d{1,3}$/.test(limitRaw)) {
    return null;
  }
  const limit = limitRaw === null ? PUBLIC_PRODUCT_LIMIT : Number(limitRaw);
  if (limit < 1 || limit > PUBLIC_PRODUCT_LIMIT) {
    return null;
  }
  const cursorRaw = params.get("cursor");
  const cursor: DisplayCursor | null = cursorRaw === null ? null : decodeDisplayCursor(cursorRaw);
  if (cursorRaw !== null && cursor === null) {
    return null;
  }
  const featured = params.get("featured");
  if (featured !== null && featured !== "1") {
    return null;
  }
  const tag = params.get("tag");
  const category = params.get("category");
  if (
    (tag !== null && (tag.length === 0 || tag.length > TAG_KEY_MAX_LENGTH)) ||
    (category !== null && (category.length === 0 || category.length > CATEGORY_KEY_MAX_LENGTH))
  ) {
    return null;
  }
  return { category, cursor, featured: featured === "1", limit, tag };
}

export async function handlePublicProductListRoute(env: Env, request: Request): Promise<Response> {
  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return notFoundResponse("Products not found");
  }
  const filter = parsePublicProductListQuery(new URL(request.url));
  if (filter === null) {
    return invalidRequestResponse();
  }
  const page = await listPublicProductPageVersioned(env, env.DB, tenant, filter);
  return page === null
    ? notFoundResponse("Products not found")
    : versionedJsonResponse(request, page.catalogVersion, page.value);
}

export async function handlePublicProductRefRoute(env: Env, request: Request): Promise<Response> {
  const ref = refSegment(request);
  if (ref === null) {
    return notFoundResponse("Product not found");
  }
  const tenant = await resolveRequestTenant(env.DB, request);
  const product =
    tenant === null ? null : await getPublicProductByRefVersioned(env, env.DB, tenant, ref);
  return product === null || product.value === null
    ? notFoundResponse("Product not found")
    : versionedJsonResponse(request, product.catalogVersion, { product: product.value });
}
