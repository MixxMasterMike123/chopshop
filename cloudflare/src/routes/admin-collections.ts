import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import type { CollectionProductsWriteResult, CollectionWriteResult } from "../catalog/collections";
import {
  COLLECTION_BODY_MAX_BYTES,
  COLLECTION_ID_PATTERN,
  COLLECTION_PRODUCTS_BODY_MAX_BYTES,
  createCollection,
  deleteCollection,
  getAdminCollection,
  listAdminCollections,
  parseAdminCollectionListQuery,
  parseCollectionInput,
  parseCollectionProductsInput,
  setCollectionProducts,
  updateCollection,
} from "../catalog/collections";
import { readJsonBodyWithin } from "../legal/legal-pages";
import { jsonResponse } from "../lib/http";
import { decodeSegment, invalidRequestResponse, routeNotFoundResponse } from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

/**
 * CP4-B — the shop admin's collections (migrations/0041):
 *
 *   GET    /v1/admin/collections?cursor&limit=1..100 (50)
 *          200 { collections: AdminCollectionSummary[], nextCursor: string | null }
 *          display order (sort order, NULL last, then title, then id)
 *   POST   /v1/admin/collections
 *          { title, handle?, externalRef?, description?, imageObjectId?, type?,
 *            ruleTag?, published?, featured?, sortOrder? }        201 { collection }
 *   GET    /v1/admin/collections/:collectionId                  200 { collection }
 *   PATCH  /v1/admin/collections/:collectionId  any non-empty subset of the POST
 *          fields                                               200 { collection }
 *   DELETE /v1/admin/collections/:collectionId                  204
 *   PUT    /v1/admin/collections/:collectionId/products
 *          [productId, …] — the whole ordered list, 0–500, each once
 *                                                               200 { collection }
 *
 *   AdminCollectionSummary = { collectionId, handle, externalRef, title, type,
 *     ruleTag, published, featured, sortOrder, path, imageObjectId,
 *     image: PublicImage | null, productCount, createdAt, updatedAt }
 *   collection = AdminCollectionSummary + { description, productIds, createdBy, updatedBy }
 *
 *   400 invalid_request                    shape, grammar, lengths; a handle
 *                                          that is not what slugify leaves; a
 *                                          smart collection without a tag or a
 *                                          manual one with one; a tag with no
 *                                          address; a product list over 500, with
 *                                          a repeat or a non-string
 *   400 { error: { code: "image_not_referencable" } }
 *                                          the cover is not an active public
 *                                          product image of this shop
 *   400 { error: { code: "product_not_found" } }
 *                                          a listed product is not one of this
 *                                          shop's (nothing is written)
 *   409 { error: { code: "handle_taken" } }        the handle names another
 *                                          collection of this shop (its handle,
 *                                          external reference or id)
 *   409 { error: { code: "external_ref_taken" } }  the same for the external
 *                                          reference
 *   409 { error: { code: "collection_not_manual" } } a product list for a
 *                                          smart collection
 *   409 { error: { code: "conflict" } }    a concurrent write the checks could
 *                                          not see
 *   413 payload_too_large                  a body over 64 KiB (256 KiB for the
 *                                          product list)
 *   404 the opaque answer: no session, no membership or acting-as grant on the
 *       named shop, a cross-origin or origin-less write, a malformed or unknown
 *       collection id, another shop's collection
 *
 * Tenant = `X-Shop-Id` checked against the session's live memberships, or a
 * platform user's live acting-as grant on it (the audit row carries the grant
 * id). Authorization first, then same-origin for every state change BEFORE
 * the body is read, then the id. Every write is audited in its own batch.
 */

export const ADMIN_COLLECTIONS_PATH = "/v1/admin/collections";
export const ADMIN_COLLECTION_ROUTE = "/v1/admin/collections/:collectionId";
export const ADMIN_COLLECTION_PRODUCTS_ROUTE = "/v1/admin/collections/:collectionId/products";

// "", "v1", "admin", "collections", :collectionId
const COLLECTION_SEGMENT = 4;

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function payloadTooLargeResponse(): Response {
  return errorResponse(413, "payload_too_large", "The request body exceeds the maximum allowed size");
}

/**
 * The principal, or null (→ the opaque 404): the method must be one the
 * route owns, the session goes first, and a state change must be same-origin.
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
  if (principal === null || (request.method !== "GET" && !isSameOriginRequest(request))) {
    return null;
  }
  return principal;
}

/** The collection id of the raw path, decoded once; null when malformed. */
function collectionIdOf(request: Request): string | null {
  const decoded = decodeSegment(new URL(request.url).pathname.split("/")[COLLECTION_SEGMENT] ?? "");
  return decoded !== null && COLLECTION_ID_PATTERN.test(decoded) ? decoded : null;
}

function writeResponse(result: CollectionWriteResult, created: boolean): Response {
  switch (result.status) {
    case "ok":
      return jsonResponse({ collection: result.collection }, created ? 201 : 200);
    case "invalid":
      return invalidRequestResponse();
    case "image_not_referencable":
      return errorResponse(400, "image_not_referencable", "The image is not a public product image of this shop");
    case "handle_taken":
      return errorResponse(409, "handle_taken", "The handle names another collection of this shop");
    case "external_ref_taken":
      return errorResponse(409, "external_ref_taken", "The external reference names another collection of this shop");
    case "conflict":
      return errorResponse(409, "conflict", "Request conflicts with the current collection state");
    case "not_found":
      return routeNotFoundResponse();
  }
}

function productsWriteResponse(result: CollectionProductsWriteResult): Response {
  switch (result.status) {
    case "ok":
      return jsonResponse({ collection: result.collection });
    case "product_not_found":
      return errorResponse(400, "product_not_found", "A listed product is not a product of this shop");
    case "not_manual":
      return errorResponse(409, "collection_not_manual", "Only a manual collection has a product list");
    case "not_found":
      return routeNotFoundResponse();
  }
}

export async function handleAdminCollectionsRoute(env: Env, request: Request): Promise<Response> {
  const principal = await adminGuard(env, request, ["GET", "POST"]);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    const query = parseAdminCollectionListQuery(new URL(request.url));
    return query === null
      ? invalidRequestResponse()
      : jsonResponse(await listAdminCollections(env, env.DB, principal.tenantId, query));
  }

  const body = await readJsonBodyWithin(request, COLLECTION_BODY_MAX_BYTES);
  if (body.status === "too_large") {
    return payloadTooLargeResponse();
  }
  const input = parseCollectionInput(body.value, "create");
  if (input === null) {
    return invalidRequestResponse();
  }
  return writeResponse(await createCollection(env, env.DB, principal, input, Date.now()), true);
}

export async function handleAdminCollectionRoute(env: Env, request: Request): Promise<Response> {
  const principal = await adminGuard(env, request, ["GET", "PATCH", "DELETE"]);
  const collectionId = collectionIdOf(request);
  if (principal === null || collectionId === null) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    const collection = await getAdminCollection(env, env.DB, principal.tenantId, collectionId);
    return collection === null ? routeNotFoundResponse() : jsonResponse({ collection });
  }

  if (request.method === "DELETE") {
    const deleted = await deleteCollection(env.DB, principal, collectionId, Date.now());
    return deleted.status === "ok" ? new Response(null, { status: 204 }) : routeNotFoundResponse();
  }

  const body = await readJsonBodyWithin(request, COLLECTION_BODY_MAX_BYTES);
  if (body.status === "too_large") {
    return payloadTooLargeResponse();
  }
  const input = parseCollectionInput(body.value, "update");
  if (input === null) {
    return invalidRequestResponse();
  }
  return writeResponse(
    await updateCollection(env, env.DB, principal, collectionId, input, Date.now()),
    false,
  );
}

export async function handleAdminCollectionProductsRoute(env: Env, request: Request): Promise<Response> {
  const principal = await adminGuard(env, request, ["PUT"]);
  const collectionId = collectionIdOf(request);
  if (principal === null || collectionId === null) {
    return routeNotFoundResponse();
  }

  const body = await readJsonBodyWithin(request, COLLECTION_PRODUCTS_BODY_MAX_BYTES);
  if (body.status === "too_large") {
    return payloadTooLargeResponse();
  }
  const productIds = parseCollectionProductsInput(body.value);
  if (productIds === null) {
    return invalidRequestResponse();
  }
  return productsWriteResponse(
    await setCollectionProducts(env, env.DB, principal, collectionId, productIds, Date.now()),
  );
}
