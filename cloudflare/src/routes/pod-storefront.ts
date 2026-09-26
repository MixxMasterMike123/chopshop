import { findPublicPreview } from "../catalog/public-catalog";
import { decodeSegment, notFoundResponse } from "../lib/responses";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

/**
 * GET /v1/storefront/pod-previews/{productId}/{artworkId} — a POD product's
 * artwork preview (the render pipeline's 800 px WebP) for the storefront.
 *
 * WHY A WORKER-SERVED PATH AND NOT A SIGNED URL. The public product detail
 * carries these paths under an `ETag: "<catalog_version>"` (PLAN §2.4); a
 * presigned URL minted per request would make every body different and expire
 * inside a 304-revalidated cache, so the two caching rules would fight. A
 * stable path keeps the detail body a pure function of the catalog, and this
 * route re-checks THE eligibility predicate on every request — a takedown or a
 * deleted mapping stops the image immediately, which no already-issued signed
 * URL could. It still reads the PRIVATE bucket (the public-bucket copy is CP4)
 * and only ever a key under this tenant's server-owned `pod/{tenant}/preview/`
 * prefix; the print master is never reachable here.
 *
 * `ETag: "<preview sha256>"` (the bytes are immutable once 'ready') +
 * `Cache-Control: no-cache`: browsers revalidate each view and get a bodiless
 * 304 while nothing changed — after the eligibility check, never before it.
 */
export const STOREFRONT_POD_PREVIEWS_PREFIX = "/v1/storefront/pod-previews/";

function notFound(): Response {
  return notFoundResponse("Preview not found");
}

export async function handlePodPreviewRoute(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return notFound();
  }
  const bucket = env.PRIVATE_BUCKET;
  if (bucket === undefined) {
    return notFound();
  }

  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(STOREFRONT_POD_PREVIEWS_PREFIX)) {
    return notFound();
  }
  const [rawProduct, rawArtwork, ...rest] = pathname
    .slice(STOREFRONT_POD_PREVIEWS_PREFIX.length)
    .split("/");
  const productId = rawProduct === undefined ? null : decodeSegment(rawProduct);
  const artworkId = rawArtwork === undefined ? null : decodeSegment(rawArtwork);
  if (productId === null || artworkId === null || rest.length > 0) {
    return notFound();
  }

  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return notFound();
  }
  const preview = await findPublicPreview(env.DB, tenant, productId, artworkId);
  if (preview === null) {
    return notFound();
  }

  const etag = `"${preview.sha256}"`;
  const headers = {
    "Cache-Control": "no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  const ifNoneMatch = request.headers.get("if-none-match");
  if (
    ifNoneMatch !== null &&
    ifNoneMatch
      .split(",")
      .map((candidate) => candidate.trim().replace(/^W\//, ""))
      .some((candidate) => candidate === etag || candidate === "*")
  ) {
    return new Response(null, { headers, status: 304 });
  }

  const object = await bucket.get(preview.key);
  if (object === null) {
    return notFound();
  }
  return new Response(object.body, {
    headers: { ...headers, "Content-Type": "image/webp" },
    status: 200,
  });
}
