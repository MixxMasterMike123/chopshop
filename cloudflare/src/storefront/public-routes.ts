import {
  getPublicProductVersioned,
  listPublicProductsVersioned,
} from "../catalog/public-catalog";
import { notFoundResponse } from "../lib/responses";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";
import { getPublicStorefrontVersioned } from "./public-storefront";

/**
 * The public read routes WITH catalog_version caching (PLAN §2.4):
 *
 *   GET /v1/storefront          → { storefront }
 *   GET /v1/products            → { products }
 *   GET /v1/products/:productId → { product }
 *
 * Every 200 carries `ETag: "<catalog_version>"` and `Cache-Control: no-cache`
 * (store, but revalidate every time — `no-store`, which jsonResponse sets, would
 * forbid the browser from keeping the body it needs to revalidate). A request
 * whose `If-None-Match` names the current version gets a bodiless 304.
 *
 * The version is bumped by trigger inside every write that changes anything
 * these bodies are built from (migrations/0025), so an unchanged version is
 * proof of an unchanged body — including eligibility: a takedown bumps it, and
 * the next request for the product answers 404, not 304.
 *
 * 404s carry no ETag and are never cacheable. The response bodies are
 * byte-identical to the unversioned routes'.
 */

function etagFor(catalogVersion: number): string {
  return `"${catalogVersion}"`;
}

/** RFC 9110 §13.1.2: a list of entity tags, or `*`; weak comparison. */
function matchesIfNoneMatch(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (header === null) {
    return false;
  }
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}

export function versionedJsonResponse(
  request: Request,
  catalogVersion: number,
  body: unknown,
): Response {
  const etag = etagFor(catalogVersion);
  const headers = {
    "Cache-Control": "no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (matchesIfNoneMatch(request, etag)) {
    return new Response(null, { headers, status: 304 });
  }
  return Response.json(body, {
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    status: 200,
  });
}

export async function handlePublicStorefrontRequest(
  env: Env,
  request: Request,
): Promise<Response> {
  const tenant = await resolveRequestTenant(env.DB, request);
  const storefront =
    tenant === null ? null : await getPublicStorefrontVersioned(env.DB, tenant);
  return storefront === null
    ? notFoundResponse("Storefront not found")
    : versionedJsonResponse(request, storefront.catalogVersion, {
        storefront: storefront.value,
      });
}

export async function handlePublicProductsRequest(
  env: Env,
  request: Request,
): Promise<Response> {
  const tenant = await resolveRequestTenant(env.DB, request);
  const products =
    tenant === null ? null : await listPublicProductsVersioned(env.DB, tenant);
  return products === null
    ? notFoundResponse("Products not found")
    : versionedJsonResponse(request, products.catalogVersion, {
        products: products.value,
      });
}

export async function handlePublicProductRequest(
  env: Env,
  request: Request,
  productId: string | null,
): Promise<Response> {
  if (productId === null || productId.length === 0) {
    return notFoundResponse("Product not found");
  }
  const tenant = await resolveRequestTenant(env.DB, request);
  const product =
    tenant === null ? null : await getPublicProductVersioned(env.DB, tenant, productId);
  return product === null || product.value === null
    ? notFoundResponse("Product not found")
    : versionedJsonResponse(request, product.catalogVersion, {
        product: product.value,
      });
}
