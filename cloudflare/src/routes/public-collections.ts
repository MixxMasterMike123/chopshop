import {
  listPublicCollections,
  parsePublicCollectionListQuery,
  parsePublicCollectionQuery,
  readPublicCollection,
} from "../catalog/collections";
import { clientIp, enforceRateLimit, visitorRateKey } from "../lib/rate-limit";
import {
  decodeSegment,
  invalidRequestResponse,
  notFoundResponse,
  rateLimitedResponse,
  routeNotFoundResponse,
} from "../lib/responses";
import { resolveStorefrontTenant } from "../storefront/preview";
import { versionedJsonResponse } from "../storefront/public-routes";

/**
 * CP4-B — the public collection reads, for the storefront AND for a shop's own
 * website (D87). The tenant is the request's hostname, as on every public
 * read; nothing is taken from the browser. Only a PUBLISHED collection of an
 * ACTIVE, PUBLISHED shop answers, and its products only through builder A's
 * public functions (THE predicate).
 *
 *   GET /v1/collections?cursor&limit=1..100 (100)
 *       200 { collections: [{ handle, externalRef, title, description, image,
 *                             path, featured, sortOrder }], nextCursor }
 *   GET /v1/collections/:ref?cursor&limit=1..100 (24)
 *       `ref` = a handle, an external reference or an id, tried in that order
 *       (one namespace per shop: a ref names at most one collection)
 *       200 { collection: { …the same shape }, products: PublicProductSummary[],
 *             nextCursor }
 *
 *       image = PublicImage | null; path = "/samling/<handle>", relative to
 *       the shop's root. A manual collection's products in the admin's order,
 *       a smart one's (its tag, by address) in the display order.
 *
 *   400 invalid_request   an unknown or repeated parameter, a bad limit or
 *                         cursor (also a cursor of the other kind of collection)
 *   404 { error: { code: "not_found", message: "Collection not found" } } — an
 *       unknown host, a suspended or unpublished shop, an unknown ref, a
 *       collection that is not published
 *   429 rate_limited      over the limit per caller (below)
 *
 * Every 200 carries `ETag: "<catalog_version>"` and answers `If-None-Match`
 * with a bodiless 304 (src/storefront/public-routes.ts versionedJsonResponse),
 * except a preview's: a valid grant (src/storefront/preview.ts) reads an
 * unpublished shop and answers no-store, no ETag, noindex.
 *
 * ── CROSS-ORIGIN (D87) ──────────────────────────────────────────────────────
 * Every answer of these two routes — 200, 304, 400, 404, 429 — carries
 * `Access-Control-Allow-Origin: *` and nothing else of CORS: no credentials
 * header (a `*` answer is never readable with credentials), no reflection of
 * the caller's Origin. The bodies hold public fields only. An `OPTIONS`
 * preflight is answered here with 204 BEFORE anything else: no rate limit, no
 * tenant, no query — the database is not touched. No other route of the API
 * answers cross-origin.
 *
 * ── THE RATE LIMIT (D87: per caller) ────────────────────────────────────────
 * 120 requests per minute per caller, the two routes together (one scope).
 * It runs FIRST — before the query is parsed and before the tenant is looked
 * up — so every attempt counts, a malformed one or one for another shop
 * included, and a refusal says the same whatever the ref, the host or the
 * shop: `429 { error: { code: "rate_limited", message: "Too many requests" } }`
 * with `Retry-After`, nothing about the limit or the window. The caller is
 * CF-Connecting-IP, which the edge sets and the caller cannot (X-Forwarded-For
 * is never read; a request without it shares the one "unknown" bucket); an
 * IPv6 address counts by its /64 (visitorRateKey), so rotating addresses
 * inside one's own network buys nothing. The address is hashed with the scope
 * and never stored.
 */

export const PUBLIC_COLLECTIONS_PATH = "/v1/collections";
export const PUBLIC_COLLECTION_ROUTE = "/v1/collections/:ref";

export const COLLECTIONS_IP_SCOPE = "collections-ip";
export const COLLECTIONS_IP_LIMIT = 120;
export const COLLECTIONS_IP_WINDOW_MS = 60 * 1_000;

// "", "v1", "collections", :ref
const REF_SEGMENT = 3;

/** How long a browser may keep the preflight's answer (a day). */
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

function withCors(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  // Without this a script of another origin reads the body and neither header:
  // no revalidation with If-None-Match, no waiting out a 429.
  response.headers.set("Access-Control-Expose-Headers", "ETag, Retry-After");
  return response;
}

/**
 * The answer to a CORS preflight: GET only, and `If-None-Match` for a script
 * that revalidates by ETag itself. Built from constants alone.
 */
function preflightResponse(): Response {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Headers": "If-None-Match",
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
      "Cache-Control": "no-store",
    },
    status: 204,
  });
}

function collectionNotFound(): Response {
  return notFoundResponse("Collection not found");
}

/** null = the caller may go on; else the 429. */
async function rateLimited(env: Env, request: Request, now: number): Promise<Response | null> {
  const decision = await enforceRateLimit(env.DB, {
    key: visitorRateKey(clientIp(request)),
    limit: COLLECTIONS_IP_LIMIT,
    now,
    scope: COLLECTIONS_IP_SCOPE,
    windowMs: COLLECTIONS_IP_WINDOW_MS,
  });
  return decision.allowed ? null : rateLimitedResponse(decision.retryAfterSeconds);
}

export async function handlePublicCollectionsRoute(
  env: Env,
  request: Request,
  // Tests pin the clock; the mounted route always uses the server's.
  options: { now?: number } = {},
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return preflightResponse();
  }
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const limited = await rateLimited(env, request, options.now ?? Date.now());
  if (limited !== null) {
    return withCors(limited);
  }
  const query = parsePublicCollectionListQuery(new URL(request.url));
  if (query === null) {
    return withCors(invalidRequestResponse());
  }
  const tenant = await resolveStorefrontTenant(env, request);
  const preview = tenant?.preview === true;
  const list =
    tenant === null ? null : await listPublicCollections(env, env.DB, tenant.tenantId, query, preview);
  return withCors(
    list === null
      ? collectionNotFound()
      : versionedJsonResponse(request, list.catalogVersion, list.value, preview),
  );
}

export async function handlePublicCollectionRoute(
  env: Env,
  request: Request,
  options: { now?: number } = {},
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return preflightResponse();
  }
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const limited = await rateLimited(env, request, options.now ?? Date.now());
  if (limited !== null) {
    return withCors(limited);
  }
  const query = parsePublicCollectionQuery(new URL(request.url));
  if (query === null) {
    return withCors(invalidRequestResponse());
  }
  const ref = decodeSegment(new URL(request.url).pathname.split("/")[REF_SEGMENT] ?? "");
  const tenant = ref === null ? null : await resolveStorefrontTenant(env, request);
  const read =
    tenant === null || ref === null
      ? ({ status: "not_found" } as const)
      : await readPublicCollection(env, env.DB, tenant, ref, query);
  switch (read.status) {
    case "ok":
      return withCors(
        versionedJsonResponse(
          request,
          read.catalogVersion,
          {
            collection: read.value.collection,
            nextCursor: read.value.nextCursor,
            products: read.value.products,
          },
          tenant?.preview === true,
        ),
      );
    case "invalid_cursor":
      return withCors(invalidRequestResponse());
    case "not_found":
      return withCors(collectionNotFound());
  }
}
