import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import type { AdminRefusalCode } from "../catalog/admin-catalog";
import { parseProductOrderInput, setProductOrder } from "../catalog/admin-catalog";
import type { DisplayCursor } from "../catalog/admin-product-reads";
import {
  decodeDisplayCursor,
  getAdminProductDetail,
  listAdminProducts,
  parseAdminProductListQuery,
} from "../catalog/admin-product-reads";
import type { ImagesWriteResult } from "../catalog/product-images";
import { parseProductImagesInput, replaceProductImages } from "../catalog/product-images";
import type { VariantWriteResult } from "../catalog/product-variants";
import {
  createProductVariant,
  deleteProductVariant,
  parseCreateVariantInput,
  parseUpdateVariantInput,
  updateProductVariant,
} from "../catalog/product-variants";
import type { PublicProductFilter } from "../catalog/public-catalog";
import {
  getPublicProductByRefVersioned,
  listPublicProductPageVersioned,
  PUBLIC_PRODUCT_LIMIT,
} from "../catalog/public-catalog";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  notFoundResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import { versionedJsonResponse } from "../storefront/public-routes";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

/**
 * CP4-A — the product routes that are new in CP4, and the two public product
 * reads with their new shapes.
 *
 * ADMIN (the shop's own admin, or a platform user's acting-as grant — the
 * tenant is the session's `X-Shop-Id`, never a path or body value). The live
 * session is checked FIRST; anyone else — no session, an ordinary user,
 * another shop's admin — gets the opaque 404 before the path, the query or
 * the body is looked at, and so does a state change that is not same-origin
 * (checked before the body is read). Reads need no same-origin check.
 *
 *   GET    /v1/admin/products                                  list
 *   GET    /v1/admin/products/:productId                       one product
 *   PUT    /v1/admin/products/order                            the display order
 *   POST   /v1/admin/products/:productId/variants              a variant
 *   PATCH  /v1/admin/products/:productId/variants/:variantId   a variant
 *   DELETE /v1/admin/products/:productId/variants/:variantId   a variant
 *   PUT    /v1/admin/products/:productId/images                the image list
 *
 * `POST /v1/admin/products`, `PATCH /v1/admin/products/:id` and the publish
 * actions stay in src/app.ts's handleAdminProductRoute; every mount here
 * claims only its own methods, so theirs fall through to it.
 *
 * PUBLIC (tenant by hostname; ETag = catalog_version, 304 on If-None-Match):
 *
 *   GET /v1/products?tag&category&featured=1&cursor&limit   { products, nextCursor }
 *   GET /v1/products/:ref                                   { product }
 *
 * Path segments are read from the RAW pathname and decoded once (see
 * ACTING_AS_ROUTE); an id segment is 1–128 characters with no "/".
 */

export const ADMIN_PRODUCT_LIST_PATH = "/v1/admin/products";
export const ADMIN_PRODUCT_ORDER_PATH = "/v1/admin/products/order";
export const ADMIN_PRODUCT_ROUTE = "/v1/admin/products/:productId";
export const ADMIN_PRODUCT_VARIANTS_ROUTE = "/v1/admin/products/:productId/variants";
export const ADMIN_PRODUCT_VARIANT_ROUTE = "/v1/admin/products/:productId/variants/:variantId";
export const ADMIN_PRODUCT_IMAGES_ROUTE = "/v1/admin/products/:productId/images";
export const PUBLIC_PRODUCTS_PATH = "/v1/products";
export const PUBLIC_PRODUCT_ROUTE = "/v1/products/:ref";

// "", "v1", "admin", "products", :productId, "variants" | "images", :variantId
const PRODUCT_SEGMENT = 4;
const VARIANT_SEGMENT = 6;
// "", "v1", "products", :ref
const REF_SEGMENT = 3;
const ID_MAX_LENGTH = 128;
/** A handle is at most 1200 characters (migrations/0040); a ref is an id or a handle. */
const REF_MAX_LENGTH = 1_200;
const TAG_KEY_MAX_LENGTH = 250;
const CATEGORY_KEY_MAX_LENGTH = 500;

/**
 * "The seller sees one number" covers codes too (src/app.ts
 * TENANT_REFUSAL_CODES, restated here for the variant refusals): the two POD
 * refusals that would say HOW the platform prices read as one neutral code.
 */
const TENANT_REFUSAL_CODES: Readonly<Record<string, string>> = {
  currency_mismatch: "pod_unavailable",
  pod_unpriced: "pod_unavailable",
};

function segment(request: Request, index: number, maxLength: number): string | null {
  const raw = new URL(request.url).pathname.split("/")[index] ?? "";
  const decoded = decodeSegment(raw);
  return decoded === null || decoded.length > maxLength ? null : decoded;
}

/**
 * The admin principal, or null (→ the opaque 404): the method must be one the
 * route owns (the router guarantees it; this is the handler's own check), the
 * session goes first, and a state change must be same-origin.
 */
async function adminGuard(
  env: Env,
  request: Request,
  methods: readonly string[],
): Promise<TenantAdminPrincipal | null> {
  if (!methods.includes(request.method)) {
    return null;
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return null;
  }
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return null;
  }
  return principal;
}

function conflictResponse(code = "conflict"): Response {
  return jsonResponse(
    {
      error: {
        code,
        message:
          code === "variant_limit"
            ? "The product holds as many variants as it may"
            : "Request conflicts with the current product state",
      },
    },
    409,
  );
}

function refusedResponse(code: AdminRefusalCode, message: string): Response {
  return jsonResponse(
    { error: { code: TENANT_REFUSAL_CODES[code] ?? code, message } },
    422,
  );
}

function reasonResponse(reason: string): Response {
  return jsonResponse(
    { error: { code: "invalid_request", message: "Request is not valid", reason } },
    400,
  );
}

// ── admin: list and read ────────────────────────────────────────────────────

export async function handleAdminProductListRoute(env: Env, request: Request): Promise<Response> {
  const principal = await adminGuard(env, request, ["GET"]);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const query = parseAdminProductListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  return jsonResponse(await listAdminProducts(env, env.DB, principal.tenantId, query));
}

export async function handleAdminProductReadRoute(env: Env, request: Request): Promise<Response> {
  const principal = await adminGuard(env, request, ["GET"]);
  const productId = segment(request, PRODUCT_SEGMENT, ID_MAX_LENGTH);
  if (principal === null || productId === null) {
    return routeNotFoundResponse();
  }
  const detail = await getAdminProductDetail(env, env.DB, principal.tenantId, productId);
  return detail === null ? routeNotFoundResponse() : jsonResponse(detail);
}

// ── admin: the display order ────────────────────────────────────────────────

export async function handleAdminProductOrderRoute(env: Env, request: Request): Promise<Response> {
  const principal = await adminGuard(env, request, ["PUT"]);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const entries = parseProductOrderInput(await readJsonBody(request));
  if (entries === null) {
    return invalidRequestResponse();
  }
  const result = await setProductOrder(env.DB, principal, entries, Date.now());
  return result.status === "ok"
    ? jsonResponse({ products: result.products })
    : routeNotFoundResponse();
}

// ── admin: variants ─────────────────────────────────────────────────────────

function variantResponse(result: VariantWriteResult, successStatus: number): Response {
  switch (result.status) {
    case "ok":
      return jsonResponse({ variant: result.variant }, successStatus);
    case "removed":
      return jsonResponse({ outcome: result.outcome, variant: result.variant });
    case "refused":
      return refusedResponse(result.code, result.message);
    case "conflict":
      return conflictResponse(result.code);
    case "invalid":
      return invalidRequestResponse();
    default:
      return routeNotFoundResponse();
  }
}

export async function handleAdminProductVariantsRoute(env: Env, request: Request): Promise<Response> {
  const principal = await adminGuard(env, request, ["POST"]);
  const productId = segment(request, PRODUCT_SEGMENT, ID_MAX_LENGTH);
  if (principal === null || productId === null) {
    return routeNotFoundResponse();
  }
  const input = parseCreateVariantInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  return variantResponse(
    await createProductVariant(env.DB, principal, productId, input, Date.now()),
    201,
  );
}

export async function handleAdminProductVariantRoute(env: Env, request: Request): Promise<Response> {
  const principal = await adminGuard(env, request, ["PATCH", "DELETE"]);
  const productId = segment(request, PRODUCT_SEGMENT, ID_MAX_LENGTH);
  const variantId = segment(request, VARIANT_SEGMENT, ID_MAX_LENGTH);
  if (principal === null || productId === null || variantId === null) {
    return routeNotFoundResponse();
  }
  if (request.method === "DELETE") {
    return variantResponse(
      await deleteProductVariant(env.DB, principal, productId, variantId, Date.now()),
      200,
    );
  }
  const input = parseUpdateVariantInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  return variantResponse(
    await updateProductVariant(env.DB, principal, productId, variantId, input, Date.now()),
    200,
  );
}

// ── admin: images ───────────────────────────────────────────────────────────

function imagesResponse(result: ImagesWriteResult): Response {
  switch (result.status) {
    case "ok":
      return jsonResponse({ images: result.images });
    case "invalid":
      return reasonResponse(result.reason);
    case "conflict":
      return conflictResponse();
    default:
      return routeNotFoundResponse();
  }
}

export async function handleAdminProductImagesRoute(env: Env, request: Request): Promise<Response> {
  const principal = await adminGuard(env, request, ["PUT"]);
  const productId = segment(request, PRODUCT_SEGMENT, ID_MAX_LENGTH);
  if (principal === null || productId === null) {
    return routeNotFoundResponse();
  }
  const input = parseProductImagesInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  return imagesResponse(
    await replaceProductImages(env, env.DB, principal, productId, input, Date.now()),
  );
}

// ── public: the product list and one product ────────────────────────────────

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
  const ref = segment(request, REF_SEGMENT, REF_MAX_LENGTH);
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
