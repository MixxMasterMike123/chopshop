import type { PlatformPrincipal } from "../auth/live-authorization";
import { authorizePlatformRequest } from "../auth/request-authorization";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import { parseTenantIdPathSegment } from "../platform/provision-tenants";
import {
  parseFeaturesInput,
  readTenantFeatures,
  readTenantStatus,
  setTenantFeatures,
} from "../platform/tenant-config";
import {
  closeTenant,
  listTenants,
  parseCloseInput,
  parseTenantListQuery,
  parseTenantPatch,
  readTenantDetail,
  setTenantPublished,
  type TenantWriteResult,
  updateTenant,
} from "../platform/tenant-directory";
import {
  deleteTenantDomain,
  listTenantDomains,
  lookupHostname,
  moveDomain,
  parseDomainIdSegment,
  parseDomainListQuery,
  parseHostname,
  parseMoveDomainInput,
  setDomainEnabled,
} from "../platform/tenant-domains";

/**
 * CP3-A — the platform's tenant surface. PLATFORM session only; everyone else
 * (no session, a tenant admin, a print operator) gets the opaque 404 before
 * the path, the query or the body is looked at. Reads need no same-origin (as
 * for every platform read); every state change does.
 *
 *   GET    /v1/platform/tenants[?status&cursor&limit]      directory
 *   GET    /v1/platform/tenants/:tenantId                   detail
 *   PATCH  /v1/platform/tenants/:tenantId                   shopName, supportEmail, vatRateBp, commissionBps
 *   POST   /v1/platform/tenants/:tenantId/publish           go-live gate on
 *   POST   /v1/platform/tenants/:tenantId/unpublish         go-live gate off
 *   POST   /v1/platform/tenants/:tenantId/close             final; 409 tenant_has_refundable_orders
 *                                                           while any order can still be refunded
 *                                                           (a shop with live orders is SUSPENDED)
 *   GET    /v1/platform/tenants/:tenantId/features          every allowed key, effective value
 *   PUT    /v1/platform/tenants/:tenantId/features          explicit values for the named keys
 *   GET    /v1/platform/tenants/:tenantId/domains[?cursor&limit]
 *   DELETE /v1/platform/tenants/:tenantId/domains/:domainId
 *   POST   /v1/platform/tenants/:tenantId/domains/:domainId/disable
 *   POST   /v1/platform/tenants/:tenantId/domains/:domainId/enable
 *   GET    /v1/platform/domains/lookup?hostname=…            who holds a hostname
 *   POST   /v1/platform/domains/move   { hostname, toTenantId }
 *
 * The older POST actions on the tenant prefix (create, activate, suspend,
 * admins, domains add) stay in src/app.ts's handler: each route here is
 * mounted with `onMethods`, so any other method falls through to it.
 *
 * Path segments are read from the RAW pathname and decoded once (see
 * ACTING_AS_ROUTE), with the same grammar as every other tenant-id path.
 */

export const PLATFORM_TENANT_LIST_PATH = "/v1/platform/tenants";
export const PLATFORM_TENANT_DETAIL_ROUTE = "/v1/platform/tenants/:tenantId";
export const PLATFORM_TENANT_PUBLISH_ROUTE = "/v1/platform/tenants/:tenantId/publish";
export const PLATFORM_TENANT_UNPUBLISH_ROUTE = "/v1/platform/tenants/:tenantId/unpublish";
export const PLATFORM_TENANT_CLOSE_ROUTE = "/v1/platform/tenants/:tenantId/close";
export const PLATFORM_TENANT_FEATURES_ROUTE = "/v1/platform/tenants/:tenantId/features";
export const PLATFORM_TENANT_DOMAINS_ROUTE = "/v1/platform/tenants/:tenantId/domains";
export const PLATFORM_TENANT_DOMAIN_ROUTE = "/v1/platform/tenants/:tenantId/domains/:domainId";
export const PLATFORM_TENANT_DOMAIN_DISABLE_ROUTE =
  "/v1/platform/tenants/:tenantId/domains/:domainId/disable";
export const PLATFORM_TENANT_DOMAIN_ENABLE_ROUTE =
  "/v1/platform/tenants/:tenantId/domains/:domainId/enable";
export const PLATFORM_DOMAIN_LOOKUP_PATH = "/v1/platform/domains/lookup";
export const PLATFORM_DOMAIN_MOVE_PATH = "/v1/platform/domains/move";

// "", "v1", "platform", "tenants", :tenantId, "domains", :domainId, action
const TENANT_SEGMENT = 4;
const DOMAIN_SEGMENT = 6;

function conflictResponse(code = "conflict", message = "Request conflicts with the current tenant state"): Response {
  return jsonResponse({ error: { code, message } }, 409);
}

/**
 * The platform principal, or null (→ the opaque 404). A state change must also
 * be same-origin; the method must be one the route owns (the router already
 * guarantees it; this is the handler's own check).
 */
async function platformGuard(
  env: Env,
  request: Request,
  methods: readonly string[],
): Promise<PlatformPrincipal | null> {
  if (!methods.includes(request.method)) {
    return null;
  }
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null) {
    return null;
  }
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    return null;
  }
  return principal;
}

function segment(request: Request, index: number): string {
  return new URL(request.url).pathname.split("/")[index] ?? "";
}

function tenantIdFrom(request: Request): string | null {
  const decoded = decodeSegment(segment(request, TENANT_SEGMENT));
  return decoded === null ? null : parseTenantIdPathSegment(decoded);
}

function writeResponse(result: TenantWriteResult): Response {
  switch (result.status) {
    case "ok":
      return jsonResponse(result.detail);
    case "conflict":
      return conflictResponse();
    default:
      return routeNotFoundResponse();
  }
}

// ── directory ───────────────────────────────────────────────────────────────

export async function handlePlatformTenantListRoute(env: Env, request: Request): Promise<Response> {
  if ((await platformGuard(env, request, ["GET"])) === null) {
    return routeNotFoundResponse();
  }
  const query = parseTenantListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  return jsonResponse(await listTenants(env.DB, query));
}

export async function handlePlatformTenantDetailRoute(env: Env, request: Request): Promise<Response> {
  const principal = await platformGuard(env, request, ["GET", "PATCH"]);
  const tenantId = tenantIdFrom(request);
  if (principal === null || tenantId === null) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    const detail = await readTenantDetail(env.DB, tenantId);
    return detail === null ? routeNotFoundResponse() : jsonResponse(detail);
  }

  const patch = parseTenantPatch(await readJsonBody(request));
  if (patch === null) {
    return invalidRequestResponse();
  }
  return writeResponse(await updateTenant(env.DB, principal, tenantId, patch, Date.now()));
}

export type TenantAction = "close" | "publish" | "unpublish";

export async function handlePlatformTenantActionRoute(
  env: Env,
  request: Request,
  action: TenantAction,
): Promise<Response> {
  const principal = await platformGuard(env, request, ["POST"]);
  const tenantId = tenantIdFrom(request);
  if (principal === null || tenantId === null) {
    return routeNotFoundResponse();
  }

  const now = Date.now();
  if (action === "close") {
    const input = parseCloseInput(await readJsonBody(request));
    if (input === null) {
      return invalidRequestResponse();
    }
    const result = await closeTenant(env.DB, principal, tenantId, input, now);
    // Closing is final and would strand a buyer's refund (no seller session
    // after close, no platform refund route): a shop with live orders is
    // SUSPENDED instead, and closed once every order is settled.
    return result.status === "refundable_orders"
      ? conflictResponse(
          "tenant_has_refundable_orders",
          "The shop has orders that can still be refunded; suspend it instead",
        )
      : writeResponse(result);
  }

  return writeResponse(
    await setTenantPublished(env.DB, principal, tenantId, action === "publish", now),
  );
}

// ── features ────────────────────────────────────────────────────────────────

export async function handlePlatformTenantFeaturesRoute(env: Env, request: Request): Promise<Response> {
  const principal = await platformGuard(env, request, ["GET", "PUT"]);
  const tenantId = tenantIdFrom(request);
  if (principal === null || tenantId === null) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    if ((await readTenantStatus(env.DB, tenantId)) === null) {
      return routeNotFoundResponse();
    }
    return jsonResponse({ features: await readTenantFeatures(env.DB, tenantId), tenantId });
  }

  const input = parseFeaturesInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const result = await setTenantFeatures(env.DB, principal, tenantId, input, Date.now());
  switch (result.status) {
    case "ok":
      return jsonResponse({ features: result.features, tenantId });
    case "conflict":
      return conflictResponse();
    default:
      return routeNotFoundResponse();
  }
}

// ── domains ─────────────────────────────────────────────────────────────────

export async function handlePlatformTenantDomainsRoute(env: Env, request: Request): Promise<Response> {
  const principal = await platformGuard(env, request, ["GET"]);
  const tenantId = tenantIdFrom(request);
  if (principal === null || tenantId === null) {
    return routeNotFoundResponse();
  }
  const query = parseDomainListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  const page = await listTenantDomains(env.DB, tenantId, query);
  return page === null ? routeNotFoundResponse() : jsonResponse({ ...page, tenantId });
}

export async function handlePlatformTenantDomainRoute(env: Env, request: Request): Promise<Response> {
  const principal = await platformGuard(env, request, ["DELETE"]);
  const tenantId = tenantIdFrom(request);
  const domainId = parseDomainIdSegment(segment(request, DOMAIN_SEGMENT));
  if (principal === null || tenantId === null || domainId === null) {
    return routeNotFoundResponse();
  }
  const result = await deleteTenantDomain(env.DB, principal, tenantId, domainId, Date.now());
  return result.status === "ok" ? new Response(null, { status: 204 }) : routeNotFoundResponse();
}

export async function handlePlatformTenantDomainActionRoute(
  env: Env,
  request: Request,
  action: "disable" | "enable",
): Promise<Response> {
  const principal = await platformGuard(env, request, ["POST"]);
  const tenantId = tenantIdFrom(request);
  const domainId = parseDomainIdSegment(segment(request, DOMAIN_SEGMENT));
  if (principal === null || tenantId === null || domainId === null) {
    return routeNotFoundResponse();
  }
  const result = await setDomainEnabled(
    env.DB,
    principal,
    tenantId,
    domainId,
    action === "enable",
    Date.now(),
  );
  switch (result.status) {
    case "ok":
      return jsonResponse({ domain: result.domain, tenantId });
    case "conflict":
      return conflictResponse();
    default:
      return routeNotFoundResponse();
  }
}

/**
 * GET, with the hostname as a query parameter: a lookup changes nothing, so it
 * is a read — no same-origin requirement (like every platform read), safe to
 * retry, and an operator can paste the URL into a browser. A hostname is not a
 * secret (it is in DNS), so carrying it in the URL leaks nothing. Answers
 * `{ domain: null }` when no tenant holds it: "nobody" is a real answer for an
 * authorized caller, not a missing route.
 */
export async function handlePlatformDomainLookupRoute(env: Env, request: Request): Promise<Response> {
  if ((await platformGuard(env, request, ["GET"])) === null) {
    return routeNotFoundResponse();
  }
  const params = new URL(request.url).searchParams;
  const keys = [...params.keys()];
  const hostname = parseHostname(params.get("hostname"));
  if (keys.length !== 1 || keys[0] !== "hostname" || hostname === null) {
    return invalidRequestResponse();
  }
  return jsonResponse({ domain: await lookupHostname(env.DB, hostname) });
}

export async function handlePlatformDomainMoveRoute(env: Env, request: Request): Promise<Response> {
  const principal = await platformGuard(env, request, ["POST"]);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const input = parseMoveDomainInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await moveDomain(env.DB, principal, input, Date.now());
  switch (result.status) {
    case "ok":
      return jsonResponse({
        domain: result.domain,
        fromTenantId: result.fromTenantId,
        moved: result.moved,
        toTenantId: result.toTenantId,
      });
    case "conflict":
      return result.reason === "hostname_unknown"
        ? conflictResponse("hostname_unknown", "No tenant holds this hostname")
        : result.reason === "target_closed"
          ? conflictResponse("tenant_closed", "The target tenant is closed")
          : conflictResponse();
    default:
      return routeNotFoundResponse();
  }
}
