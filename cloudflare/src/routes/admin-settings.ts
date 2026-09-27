import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import { jsonResponse } from "../lib/http";
import {
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import {
  parseStoreSettingsInput,
  readTenantSettings,
  writeTenantSettings,
} from "../platform/tenant-config";

/**
 * CP3-A — the shop admin's store settings (migrations/0032 tenant_settings):
 *
 *   GET /v1/admin/settings
 *       200 { settings: { storeIdentity, returnAddress, vatRegistered,
 *                         vatNumber, sellerType, updatedAt } }
 *   PUT /v1/admin/settings   any non-empty subset of
 *       { storeIdentity, returnAddress, vatRegistered, vatNumber, sellerType }
 *       200 { settings }                     each PRESENT field replaced
 *       400 invalid_request                  shape, size, depth, types
 *       400 refused_store_identity_keys      { keys: [...] } the identity carries
 *                                            a key owned elsewhere
 *                                            (tenant-config.ts REFUSED_…)
 *       404                                  no session, no membership, no
 *                                            acting-as grant, cross-origin PUT
 *
 * Tenant = `X-Shop-Id` checked against the session's live memberships, or a
 * platform user's live acting-as grant on it (admitted here, unlike the
 * platform-terms acceptance: store settings are operational data an operator
 * may fix on the seller's behalf, and the audit row carries the grant id).
 *
 * The seller's own data only: no commission, no cost, no Connect internals
 * (the one-number rule). Nothing here is served on a public surface.
 */

export const ADMIN_SETTINGS_PATH = "/v1/admin/settings";

export async function handleAdminSettingsRoute(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || (request.method === "PUT" && !isSameOriginRequest(request))) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    return jsonResponse({ settings: await readTenantSettings(env.DB, principal.tenantId) });
  }

  const parsed = parseStoreSettingsInput(await readJsonBody(request));
  if (parsed.status === "invalid") {
    return invalidRequestResponse();
  }
  if (parsed.status === "refused") {
    return jsonResponse(
      {
        error: {
          code: "refused_store_identity_keys",
          keys: parsed.keys,
          message: "The store identity carries keys this route does not accept",
        },
      },
      400,
    );
  }

  return jsonResponse({
    settings: await writeTenantSettings(env.DB, principal, parsed.input, Date.now()),
  });
}
