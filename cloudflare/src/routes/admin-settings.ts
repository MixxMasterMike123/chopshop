import type { TenantAdminPrincipal } from "../auth/live-authorization";
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
  parseStoreSettingsPatchInput,
  patchTenantSettings,
  readTenantSettings,
  unreferencableStoreIdentityImages,
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
 *   PATCH /v1/admin/settings  (CP5-WK, unit WD; tenant-config.ts "the fenced
 *                              partial write" for what merge means)
 *       { expectedUpdatedAt: <updatedAt as read> | null,
 *         storeIdentity?: { <top-level key>: <value>, … },   each key REPLACED
 *         returnAddress?, vatRegistered?, vatNumber?, sellerType? }
 *       200 { settings }                     the merged settings
 *       409 { error: { code: "conflict" }, settings }
 *                                            the row is not at expectedUpdatedAt
 *                                            (nothing written; `settings` is
 *                                            what is stored now)
 *       400 invalid_request · refused_store_identity_keys · unreferencable_images
 *                                            as the PUT, for the keys written; the
 *                                            merged identity over the size cap is
 *                                            invalid_request
 *       404                                  as the PUT (cross-origin PATCH too)
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
  if (request.method !== "GET" && request.method !== "PUT" && request.method !== "PATCH") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || (request.method !== "GET" && !isSameOriginRequest(request))) {
    return routeNotFoundResponse();
  }

  if (request.method === "GET") {
    return jsonResponse({ settings: await readTenantSettings(env.DB, principal.tenantId) });
  }

  if (request.method === "PATCH") {
    return patchSettings(env, principal, request);
  }

  const parsed = parseStoreSettingsInput(await readJsonBody(request));
  if (parsed.status === "invalid") {
    return invalidRequestResponse();
  }
  if (parsed.status === "refused") {
    return refusedKeysResponse(parsed.keys);
  }

  // CP4-D: an image the identity names is an active public branding image of
  // THIS shop, or the write is refused whole.
  if (parsed.input.storeIdentityJson !== undefined) {
    const keys = await unreferencableStoreIdentityImages(
      env,
      env.DB,
      principal.tenantId,
      parsed.input.storeIdentityJson,
    );
    if (keys.length > 0) {
      return unreferencableImagesResponse(keys);
    }
  }

  return jsonResponse({
    settings: await writeTenantSettings(env.DB, principal, parsed.input, Date.now()),
  });
}

function refusedKeysResponse(keys: string[]): Response {
  return jsonResponse(
    {
      error: {
        code: "refused_store_identity_keys",
        keys,
        message: "The store identity carries keys this route does not accept",
      },
    },
    400,
  );
}

function unreferencableImagesResponse(keys: string[]): Response {
  return jsonResponse(
    {
      error: {
        code: "unreferencable_images",
        keys,
        message: "The store identity names an image this shop cannot use",
      },
    },
    400,
  );
}

/** PATCH: the PUT's checks on the keys written, then the fenced write. */
async function patchSettings(
  env: Env,
  principal: TenantAdminPrincipal,
  request: Request,
): Promise<Response> {
  const parsed = parseStoreSettingsPatchInput(await readJsonBody(request));
  if (parsed.status === "invalid") {
    return invalidRequestResponse();
  }
  if (parsed.status === "refused") {
    return refusedKeysResponse(parsed.keys);
  }

  // Only the images the PATCHED keys name: an untouched key is not re-checked.
  if (parsed.input.identityPatchJson !== undefined) {
    const keys = await unreferencableStoreIdentityImages(
      env,
      env.DB,
      principal.tenantId,
      parsed.input.identityPatchJson,
    );
    if (keys.length > 0) {
      return unreferencableImagesResponse(keys);
    }
  }

  const result = await patchTenantSettings(env.DB, principal, parsed.input, Date.now());
  switch (result.status) {
    case "ok":
      return jsonResponse({ settings: result.settings });
    case "stale":
      return jsonResponse(
        {
          error: {
            code: "conflict",
            message: "The settings changed since they were read; read them again and retry",
          },
          settings: result.settings,
        },
        409,
      );
    case "invalid":
      return invalidRequestResponse();
  }
}
