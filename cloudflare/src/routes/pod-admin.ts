import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import {
  createMapping,
  deleteMapping,
  listMappings,
  parseCreateMappingInput,
  quoteForProduct,
} from "../pod/pod-mappings";
import { listTenantPrinters } from "../pod/printers";

/**
 * The tenant-admin POD product path (CP2-C):
 *
 *   GET    /v1/admin/pod/printers                  → { printers }         capability only
 *   GET    /v1/admin/pod/mappings[?productId=]     → { mappings }
 *   POST   /v1/admin/pod/mappings                  → 201|200 { mapping, inkopMinor, priceFloorMinor, currency }
 *   DELETE /v1/admin/pod/mappings/{mappingId}      → 204
 *   GET    /v1/admin/pod/quote?productId=[&variantId=] → { inkopMinor, priceFloorMinor, currency }
 *
 * Same guard order as every admin surface: the live session + X-Shop-Id
 * membership guard first, then the same-origin check on state changes only
 * (browsers send no Origin on a same-origin GET), before any body or query is
 * read. Every guard failure — and an unknown or foreign id — is the one opaque
 * 404, so the surface is not an oracle for which ids exist.
 *
 * ONE NUMBER (A13): the only money any of these responses carries is
 * `inkopMinor` (the production cost of one item, ex VAT) and `priceFloorMinor`
 * (PRISGOLV). No tier, blank, print price, platform cut, shipping or supplier
 * figure is ever serialized here — test/pod-mappings.test.ts walks every
 * response body for those keys.
 */
export const ADMIN_POD_MAPPINGS_PATH = "/v1/admin/pod/mappings";
export const ADMIN_POD_MAPPING_PATH_PREFIX = "/v1/admin/pod/mappings/";
export const ADMIN_POD_QUOTE_PATH = "/v1/admin/pod/quote";
export const ADMIN_POD_PRINTERS_PATH = "/v1/admin/pod/printers";

const ID_MAX_LENGTH = 128;

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function queryId(url: URL, name: string): string | null | undefined {
  const value = url.searchParams.get(name);
  if (value === null) {
    return undefined;
  }
  return value.length >= 1 && value.length <= ID_MAX_LENGTH ? value : null;
}

function mappingIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(ADMIN_POD_MAPPING_PATH_PREFIX)) {
    return null;
  }
  const rest = pathname.slice(ADMIN_POD_MAPPING_PATH_PREFIX.length);
  return rest.includes("/") ? null : decodeSegment(rest);
}

export async function handleAdminPodProductRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }

  const url = new URL(request.url);
  const now = Date.now();

  if (url.pathname === ADMIN_POD_PRINTERS_PATH) {
    return request.method === "GET"
      ? jsonResponse({ printers: await listTenantPrinters(env.DB, principal.tenantId) })
      : routeNotFoundResponse();
  }

  if (url.pathname === ADMIN_POD_QUOTE_PATH) {
    if (request.method !== "GET") {
      return routeNotFoundResponse();
    }
    const productId = queryId(url, "productId");
    const variantId = queryId(url, "variantId");
    if (productId === undefined || productId === null || variantId === null) {
      return invalidRequestResponse();
    }
    const result = await quoteForProduct(env.DB, principal, productId, variantId ?? null);
    if (result.status !== "ok") {
      return result.status === "not_found"
        ? routeNotFoundResponse()
        : errorResponse(422, "not_quotable", "Product has no priced POD mapping");
    }
    return jsonResponse({
      currency: result.quote.currency,
      inkopMinor: result.quote.inkopMinor,
      priceFloorMinor: result.quote.priceFloorMinor,
    });
  }

  if (url.pathname === ADMIN_POD_MAPPINGS_PATH) {
    if (request.method === "GET") {
      const productId = queryId(url, "productId");
      if (productId === null) {
        return invalidRequestResponse();
      }
      return jsonResponse({
        mappings: await listMappings(env.DB, principal, productId ?? null),
      });
    }
    if (request.method !== "POST") {
      return routeNotFoundResponse();
    }

    const input = parseCreateMappingInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }
    const result = await createMapping(env.DB, principal, input, now);
    if (result.status === "not_found") {
      return routeNotFoundResponse();
    }
    if (result.status === "conflict") {
      return errorResponse(409, result.code, "Request conflicts with the current mapping state");
    }
    if (result.status === "refused") {
      return errorResponse(422, result.code, "Mapping cannot be created");
    }
    return jsonResponse(
      {
        currency: result.quote.currency,
        inkopMinor: result.quote.inkopMinor,
        mapping: result.mapping,
        priceFloorMinor: result.quote.priceFloorMinor,
      },
      result.created ? 201 : 200,
    );
  }

  const mappingId = mappingIdFromPath(url.pathname);
  if (mappingId === null || request.method !== "DELETE") {
    return routeNotFoundResponse();
  }
  const deleted = await deleteMapping(env.DB, principal, mappingId, now);
  if (deleted.status === "conflict") {
    return errorResponse(409, "conflict", "Request conflicts with the current mapping state");
  }
  return deleted.status === "ok"
    ? new Response(null, { status: 204 })
    : routeNotFoundResponse();
}
