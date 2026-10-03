import { notFoundResponse } from "../lib/responses";
import { previewJsonResponse, resolveStorefrontTenant } from "./preview";
import { getPublicStorefrontVersioned } from "./public-storefront";

/**
 * The storefront response WITH catalog_version caching (PLAN §2.4), and the
 * one ETag answer every public read of CP4 uses (`versionedJsonResponse`):
 *
 *   GET /v1/storefront          → { storefront }   (CP4-D: the full response)
 *
 * The product reads are src/routes/public-products.ts (CP4-A).
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
 * 404s carry no ETag and are never cacheable.
 *
 * A PREVIEW (D57, preview.ts): a read whose tenant a valid grant marked
 * answers through `versionedJsonResponse(…, true)` — the body with
 * `Cache-Control: no-store`, no ETag, `X-Robots-Tag: noindex`, and never a 304.
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
  preview = false,
): Response {
  if (preview) {
    return previewJsonResponse(body);
  }
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

/**
 * `GET /v1/storefront` — the full public response (CP4-D, public-storefront.ts):
 * `{ storefront: { name, locale, currency, identity, branding, menu, features,
 * pickupLocations, templateId, theme, accent } }`. An unknown, suspended or
 * unpublished shop is the 404 below; an unpublished one answers to a valid
 * preview grant (preview.ts).
 */
export async function handlePublicStorefrontRequest(
  env: Env,
  request: Request,
): Promise<Response> {
  const tenant = await resolveStorefrontTenant(env, request);
  const storefront =
    tenant === null ? null : await getPublicStorefrontVersioned(env, env.DB, tenant);
  return storefront === null
    ? notFoundResponse("Storefront not found")
    : versionedJsonResponse(
        request,
        storefront.catalogVersion,
        { storefront: storefront.value },
        tenant?.preview === true,
      );
}
