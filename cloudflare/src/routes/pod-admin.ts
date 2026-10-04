import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import { printCanvasEnabled } from "../dispatch/print-canvas";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import type { PodMapping } from "../pod/pod-mappings";
import {
  createMapping,
  deleteMapping,
  designQuote,
  listMappings,
  parseCreateMappingInput,
  parseDesignQuoteQuery,
  podRefusalMessage,
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
 *   GET    /v1/admin/pod/design-quote?printerId=&sku=&slots=a,b → { inkopMinor, priceFloorMinor, currency }
 *          (CP5-WG; its own handler below, mounted by src/app.ts CP5-ROUTES-G)
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
 * response body for those keys, and test/printers-platform.test.ts walks
 * every key AND value of every answer (success and error) against the
 * platform's actual prices and catalogue.
 *
 * "Never show our hand" covers refusals too (CP3): a refusal that would tell
 * the seller HOW the platform prices — `unpriced` (the printer has no price
 * row for that SKU/slot) or `currency_mismatch` (the printer is priced in
 * another currency) — answers with the code the seller can act on instead:
 * the SKU / the printer is unavailable to them. The mapping functions keep
 * the precise codes for the platform's own use.
 */
export const ADMIN_POD_MAPPINGS_PATH = "/v1/admin/pod/mappings";
export const ADMIN_POD_MAPPING_PATH_PREFIX = "/v1/admin/pod/mappings/";
export const ADMIN_POD_QUOTE_PATH = "/v1/admin/pod/quote";
export const ADMIN_POD_PRINTERS_PATH = "/v1/admin/pod/printers";
export const ADMIN_POD_DESIGN_QUOTE_PATH = "/v1/admin/pod/design-quote";

const ID_MAX_LENGTH = 128;

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/** The code a tenant sees for a refusal (see the header: pricing structure stays hidden). */
const TENANT_REFUSAL_CODE: Readonly<Record<string, string>> = {
  currency_mismatch: "printer_unavailable",
  unpriced: "sku_unavailable",
};

function tenantRefusalCode(code: string): string {
  return TENANT_REFUSAL_CODE[code] ?? code;
}

/**
 * A mapping as a tenant sees it, rebuilt field by field (allowlist). A
 * mapping suspended because its SKU/slot lost its price row reads as
 * `sku_unavailable`, for the same reason as the refusal codes above; the
 * seller's remedy (re-post or delete the mapping) is the same.
 */
function tenantMapping(mapping: PodMapping): PodMapping {
  return {
    artworkId: mapping.artworkId,
    createdAt: mapping.createdAt,
    mappingId: mapping.mappingId,
    printerId: mapping.printerId,
    productId: mapping.productId,
    sku: mapping.sku,
    slots: mapping.slots.map(({ heightMm, slot, widthMm }) => ({ heightMm, slot, widthMm })),
    status: mapping.status,
    suspendedReason:
      mapping.suspendedReason === null ? null : tenantRefusalCode(mapping.suspendedReason),
    updatedAt: mapping.updatedAt,
    variantId: mapping.variantId,
  };
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
        : errorResponse(422, "not_quotable", "Product has no POD mapping that can be produced");
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
        mappings: (await listMappings(env.DB, principal, productId ?? null)).map(tenantMapping),
      });
    }
    if (request.method !== "POST") {
      return routeNotFoundResponse();
    }

    const input = parseCreateMappingInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }
    const result = await createMapping(env.DB, principal, input, now, {
      refuseStandInFrames: printCanvasEnabled(env),
    });
    if (result.status === "not_found") {
      return routeNotFoundResponse();
    }
    if (result.status === "conflict") {
      return errorResponse(
        409,
        result.code,
        result.code === "pod_too_large"
          ? podRefusalMessage(result.code)
          : "Request conflicts with the current mapping state",
      );
    }
    if (result.status === "refused") {
      return errorResponse(
        422,
        tenantRefusalCode(result.code),
        // The two refusals the seller acts on with words of their own.
        result.code === "price_below_floor" || result.code === "pod_frame_unconfirmed"
          ? podRefusalMessage(result.code)
          : "Mapping cannot be created",
      );
    }
    return jsonResponse(
      {
        currency: result.quote.currency,
        inkopMinor: result.quote.inkopMinor,
        mapping: tenantMapping(result.mapping),
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
  if (deleted.status === "refused") {
    return errorResponse(422, deleted.code, podRefusalMessage(deleted.code));
  }
  if (deleted.status === "conflict") {
    return errorResponse(409, "conflict", "Request conflicts with the current mapping state");
  }
  return deleted.status === "ok"
    ? new Response(null, { status: 204 })
    : routeNotFoundResponse();
}

/**
 * GET /v1/admin/pod/design-quote?printerId=&sku=&slots=front,back (CP5-WG)
 *   → 200 { inkopMinor, priceFloorMinor, currency }
 *   → 400 invalid_request (a parameter missing, repeated, unknown or malformed)
 *   → 422 printer_unavailable | sku_unavailable | slot_not_printable
 *   → 404 the opaque answer (no session, no membership of X-Shop-Id, wrong method)
 *
 * A SEPARATE PATH rather than a second mode of /quote: /quote answers "what
 * does this mapped product cost" and its refusals (404 for an unknown
 * product, `not_quotable` for one with no producible mapping) mean that; a
 * choice made before any product exists has the mapping write's refusals
 * instead (is this printer, SKU and slot set usable by this shop). Two
 * contracts on one path would make either refusal ambiguous. The NUMBERS are
 * one formula: pod-mappings.ts designQuote prices through the same function
 * as the mapping write and the product quote (sellerQuoteForChoice).
 *
 * Masked as everywhere on this surface (TENANT_REFUSAL_CODE): `unpriced` reads
 * `sku_unavailable`, `currency_mismatch` reads `printer_unavailable`, so the
 * answer never says whether a price row or the printer's currency was what
 * was missing. Bounded as /quote is: one tenant read, one printer read, one
 * tier read, whatever the input; the input itself is capped by the parser
 * (ids ≤ 128, a SKU key, ≤ 5 slots). No rate limit, as /quote has none: both
 * are reads behind a live admin session (see the report on what a sequence of
 * quotes can tell a seller).
 */
export async function handleAdminPodDesignQuoteRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const input = parseDesignQuoteQuery(new URL(request.url).searchParams);
  if (input === null) {
    return invalidRequestResponse();
  }
  const result = await designQuote(env.DB, principal, input);
  if (result.status === "not_found") {
    return routeNotFoundResponse();
  }
  if (result.status === "refused") {
    return errorResponse(422, tenantRefusalCode(result.code), "This choice cannot be produced");
  }
  return jsonResponse({
    currency: result.quote.currency,
    inkopMinor: result.quote.inkopMinor,
    priceFloorMinor: result.quote.priceFloorMinor,
  });
}
