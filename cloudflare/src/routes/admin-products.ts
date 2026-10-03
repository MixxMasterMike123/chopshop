import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import type { AdminRefusalCode } from "../catalog/admin-catalog";
import {
  parseProductOrderInput,
  setProductOrder,
  TENANT_REFUSAL_CODES,
} from "../catalog/admin-catalog";
import {
  getAdminProductDetail,
  listAdminProducts,
  listAdminTags,
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
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

/**
 * CP4-A — the admin product routes that are new in CP4. The two public product
 * reads are in src/routes/public-products.ts.
 *
 * ADMIN (the shop's own admin, or a platform user's acting-as grant — the
 * tenant is the session's `X-Shop-Id`, never a path or body value). The live
 * session is checked FIRST; anyone else — no session, an ordinary user,
 * another shop's admin — gets the opaque 404 before the path, the query or
 * the body is looked at, and so does a state change that is not same-origin
 * (checked before the body is read). Reads need no same-origin check.
 *
 *   GET    /v1/admin/products                                  list; each item carries
 *                                                              `tags` and `variantCount` (CP5-WJ)
 *   GET    /v1/admin/tags                                      the shop's distinct tags (CP5-WJ):
 *          200 { tags: [{ tag, tagKey, productCount }], truncated }   no query parameter
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
 * Path segments are read from the RAW pathname and decoded once (see
 * ACTING_AS_ROUTE); an id segment is 1–128 characters with no "/".
 */

export const ADMIN_PRODUCT_LIST_PATH = "/v1/admin/products";
export const ADMIN_TAG_LIST_PATH = "/v1/admin/tags";
export const ADMIN_PRODUCT_ORDER_PATH = "/v1/admin/products/order";
export const ADMIN_PRODUCT_ROUTE = "/v1/admin/products/:productId";
export const ADMIN_PRODUCT_VARIANTS_ROUTE = "/v1/admin/products/:productId/variants";
export const ADMIN_PRODUCT_VARIANT_ROUTE = "/v1/admin/products/:productId/variants/:variantId";
export const ADMIN_PRODUCT_IMAGES_ROUTE = "/v1/admin/products/:productId/images";

// "", "v1", "admin", "products", :productId, "variants" | "images", :variantId
const PRODUCT_SEGMENT = 4;
const VARIANT_SEGMENT = 6;
const ID_MAX_LENGTH = 128;

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

/** GET /v1/admin/tags — no parameter of any kind is accepted (400). */
export async function handleAdminTagListRoute(env: Env, request: Request): Promise<Response> {
  const principal = await adminGuard(env, request, ["GET"]);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  if (new URL(request.url).search !== "") {
    return invalidRequestResponse();
  }
  return jsonResponse(await listAdminTags(env.DB, principal.tenantId));
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
