import {
  authorizeTenantAdminRequest,
  resolveSessionIdentity,
  SHOP_ID_HEADER,
} from "../auth/request-authorization";
import { readSessionSelf } from "../auth/session-self";
import { jsonResponse } from "../lib/http";
import { invalidRequestResponse, routeNotFoundResponse } from "../lib/responses";
import {
  DELETED_FEATURE_KEYS,
  NOT_PORTED_FEATURE_KEYS,
  readTenantFeatures,
} from "../platform/tenant-config";
import { PORTED_FEATURE_KEYS } from "../storefront/public-storefront";

/**
 * CP5-WA — the two reads every admin page starts from
 * (docs/cf-port/CP5_BRIEFS.md §0.2):
 *
 *   GET /v1/me            (no X-Shop-Id)
 *       200 { user: { id, email, name },
 *             accountType: "tenant_admin" | "platform_admin",
 *             platform: boolean,
 *             memberships: [{ tenantId, shopName, status, published, role: "admin" }],
 *             actingAs:    [{ tenantId, shopName, expiresAt }] }
 *       401 { error: { code: "unauthenticated" } }   no session, an identity
 *                                                    that is not active, or an
 *                                                    account type the admin
 *                                                    surface does not serve
 *       400 invalid_request                          the request names a shop
 *
 *   GET /v1/admin/shop    (X-Shop-Id; membership or acting-as)
 *       200 { shop: { tenantId, shopName, supportEmail, status, published,
 *                     defaultLocale, currency, vatRateBp, features: { key: bool } } }
 *       404                                          as every admin route
 *
 * `/v1/me` is the ONE admin-surface route that answers 401 rather than the
 * opaque 404 (gap analysis 0.6): the client must tell "signed out" from "not
 * found", and the answer says nothing about any shop. Its 401 is the same for
 * every reason, so it cannot be used to learn whether an account exists or is
 * suspended.
 *
 * X-Shop-Id on `/v1/me` is REFUSED, before the session is read, as the platform
 * guard refuses it (D70: a request that names a shop is made in that shop's
 * context, and `/v1/me` is not a shop's read). Refused with 400, not 401 or
 * 404: either of those would tell the client "signed out" or "gone" when the
 * fault is the client's own request, and the admin client never sends it here.
 */

export const ME_PATH = "/v1/me";
export const ADMIN_SHOP_PATH = "/v1/admin/shop";

/**
 * A key the admin build reads that is not a `tenant_features` key, and is ON
 * for every shop: pickup is core (CP4 checkout validates the shop's pickup
 * places), not an add-on.
 */
const CORE_FEATURE_KEYS = ["pickup"] as const;

function unauthenticatedResponse(): Response {
  return jsonResponse({ error: { code: "unauthenticated" } }, 401);
}

export async function handleMeRoute(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }
  if (request.headers.has(SHOP_ID_HEADER)) {
    return invalidRequestResponse();
  }

  const identity = await resolveSessionIdentity(env, request);
  if (identity === null) {
    return unauthenticatedResponse();
  }

  const self = await readSessionSelf(env.DB, identity.userId, Date.now());
  if (self === null) {
    return unauthenticatedResponse();
  }

  return jsonResponse({
    user: self.user,
    accountType: self.accountType,
    platform: self.platform,
    memberships: self.memberships,
    actingAs: self.actingAs,
  });
}

interface AdminShopRow {
  default_currency: string;
  default_locale: string;
  published: number;
  shop_name: string | null;
  status: string;
  support_email: string | null;
  tenant_id: string;
  vat_rate_bp: number;
}

/**
 * Every key the admin's menu reads, each a boolean (D81): a `tenant_features`
 * key is its effective value AND ported (the storefront's PORTED_FEATURE_KEYS,
 * the one list of what runs on Cloudflare); a key not ported or deleted from
 * the product is false whatever any row says; a core key is true.
 */
export function adminFeatures(
  views: ReadonlyArray<{ enabled: boolean; key: string }>,
): Record<string, boolean> {
  const features: Record<string, boolean> = {};
  for (const key of [...NOT_PORTED_FEATURE_KEYS, ...DELETED_FEATURE_KEYS]) {
    features[key] = false;
  }
  for (const view of views) {
    features[view.key] =
      view.enabled && (PORTED_FEATURE_KEYS as readonly string[]).includes(view.key);
  }
  for (const key of CORE_FEATURE_KEYS) {
    features[key] = true;
  }
  return features;
}

export async function handleAdminShopRoute(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  // Named columns only: the tenant row also holds the commission and the
  // Connect facts, which no seller surface carries (the one-number rule).
  const row = await env.DB
    .prepare(
      `SELECT tenant_id, shop_name, support_email, status, published,
              default_locale, default_currency, vat_rate_bp
       FROM tenants
       WHERE tenant_id = ?
       LIMIT 1`,
    )
    .bind(principal.tenantId)
    .first<AdminShopRow>();
  if (row === null) {
    return routeNotFoundResponse();
  }

  return jsonResponse({
    shop: {
      tenantId: row.tenant_id,
      shopName: row.shop_name,
      supportEmail: row.support_email,
      status: row.status,
      published: row.published === 1,
      defaultLocale: row.default_locale,
      currency: row.default_currency,
      vatRateBp: row.vat_rate_bp,
      features: adminFeatures(await readTenantFeatures(env.DB, row.tenant_id)),
    },
  });
}
