import { parseApplyInput, submitApplication } from "../affiliate/applications";
import {
  DEFAULT_COMMISSION_BP,
  DEFAULT_DISCOUNT_BP,
  readCurrentAffiliateTerms,
  renderAffiliateTerms,
} from "../affiliate/terms";
import { jsonResponse } from "../lib/http";
import { clientIp, enforceRateLimit, visitorRateKey } from "../lib/rate-limit";
import {
  invalidRequestResponse,
  rateLimitedResponse,
  readJsonBodyWithin,
  routeNotFoundResponse,
} from "../lib/responses";
import { nudgeOutbox } from "../outbox/nudge";
import { isFeatureEnabled } from "../platform/tenant-config";
import { isPublicShop } from "../storefront/public-storefront";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

/**
 * CP13 — the storefront's two affiliate routes (design §5.1, §7.1). Storefront
 * routes: mounted inside app.ts's `storefront(...)`, no session, the tenant
 * from the verified hostname and nothing else, the web Worker's allowlist the
 * one public boundary. FLAT paths (`/v1/affiliate-…`): the `/v1/affiliate/*`
 * prefix is the PORTAL's (admin host, X-Shop-Id), R2-20. Both answer the
 * opaque 404 while the shop's `affiliate` add-on is OFF (A12: the form is
 * gone) and for a shop that is not public.
 *
 *   POST /v1/affiliate-applications
 *     { name, email, phone?, socials?: { website?, instagram?, youtube?,
 *       facebook?, tiktok? }, promotionMethod, message?, preferredLang,
 *       termsVersion, termsAccepted: true }
 *     202 { applicationId }        ALWAYS after validation — also for an
 *                                  address that already has a pending
 *                                  application here (nothing is stored or
 *                                  sent then; the id names no row)
 *     400 invalid_request          a malformed body, or a terms version that
 *                                  is not the current one
 *     404 (the opaque one)         no public shop, the add-on off, any method
 *                                  but POST
 *     429 rate_limited             the 6th application from one visitor in an
 *                                  hour, or the 21st to one shop in a day
 *
 *   GET /v1/affiliate-terms
 *     200 { terms: { version, publishedAt, sha256, text } }  the current
 *         version rendered for the shop at the default rates (15 % / 10 %)
 *     404 (the opaque one)         as above
 *
 * THE LIMITS (design §5.1): per visitor (an IPv6 address by its /64) BEFORE
 * the body is read, and per shop, both on the durable limiter (hashed keys,
 * 0008). Every admitted request counts, accepted or not.
 */

export const STOREFRONT_AFFILIATE_APPLICATIONS_PATH = "/v1/affiliate-applications";
export const STOREFRONT_AFFILIATE_TERMS_PATH = "/v1/affiliate-terms";

const HOUR_MS = 60 * 60 * 1_000;
export const AFFILIATE_APPLY_IP_SCOPE = "affiliate-apply-ip";
export const AFFILIATE_APPLY_IP_LIMIT = 5;
export const AFFILIATE_APPLY_IP_WINDOW_MS = HOUR_MS;
export const AFFILIATE_APPLY_TENANT_SCOPE = "affiliate-apply-tenant";
export const AFFILIATE_APPLY_TENANT_LIMIT = 20;
export const AFFILIATE_APPLY_TENANT_WINDOW_MS = 24 * HOUR_MS;

/** A bounded form: names, links and a 2 000-character message. */
export const AFFILIATE_APPLY_BODY_MAX_BYTES = 16_384;

/** The shop, when it is public and its affiliate add-on is on; else null. */
async function affiliateShop(env: Env, request: Request) {
  const tenant = await resolveRequestTenant(env.DB, request);
  if (
    tenant === null ||
    !(await isPublicShop(env.DB, tenant.tenantId)) ||
    !(await isFeatureEnabled(env.DB, tenant.tenantId, "affiliate"))
  ) {
    return null;
  }
  return tenant;
}

export async function handleStorefrontAffiliateApplicationRoute(
  env: Env,
  request: Request,
  options: { now?: number } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const tenant = await affiliateShop(env, request);
  if (tenant === null) {
    return routeNotFoundResponse();
  }

  const now = options.now ?? Date.now();
  const byVisitor = await enforceRateLimit(env.DB, {
    key: visitorRateKey(clientIp(request)),
    limit: AFFILIATE_APPLY_IP_LIMIT,
    now,
    scope: AFFILIATE_APPLY_IP_SCOPE,
    windowMs: AFFILIATE_APPLY_IP_WINDOW_MS,
  });
  if (!byVisitor.allowed) {
    return rateLimitedResponse(byVisitor.retryAfterSeconds);
  }
  const byShop = await enforceRateLimit(env.DB, {
    key: tenant.tenantId,
    limit: AFFILIATE_APPLY_TENANT_LIMIT,
    now,
    scope: AFFILIATE_APPLY_TENANT_SCOPE,
    windowMs: AFFILIATE_APPLY_TENANT_WINDOW_MS,
  });
  if (!byShop.allowed) {
    return rateLimitedResponse(byShop.retryAfterSeconds);
  }

  const body = await readJsonBodyWithin(request, AFFILIATE_APPLY_BODY_MAX_BYTES);
  const input = body.status === "ok" ? parseApplyInput(body.value) : null;
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await submitApplication(env.DB, tenant, input, now);
  if (result.status === "stale_terms") {
    return invalidRequestResponse();
  }
  // The two mails go now rather than at the next sweep; a lost nudge is the
  // sweeper's (nudgeOutbox never throws). A duplicate's ids name no row.
  await nudgeOutbox(env, result.outboxIds);
  return jsonResponse({ applicationId: result.applicationId }, 202);
}

export async function handleStorefrontAffiliateTermsRoute(
  env: Env,
  request: Request,
  options: { now?: number } = {},
): Promise<Response> {
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const tenant = await affiliateShop(env, request);
  if (tenant === null) {
    return routeNotFoundResponse();
  }
  const now = options.now ?? Date.now();
  const terms = await readCurrentAffiliateTerms(env.DB, now);
  const shop = await env.DB
    .prepare("SELECT shop_name, support_email FROM tenants WHERE tenant_id = ? LIMIT 1")
    .bind(tenant.tenantId)
    .first<{ shop_name: string | null; support_email: string | null }>();
  if (terms === null || shop === null) {
    return routeNotFoundResponse();
  }
  return jsonResponse({
    terms: {
      publishedAt: terms.publishedAt,
      sha256: terms.sha256,
      text: renderAffiliateTerms({
        commissionBp: DEFAULT_COMMISSION_BP,
        discountBp: DEFAULT_DISCOUNT_BP,
        shopName: shop.shop_name,
        supportEmail: shop.support_email,
      }),
      version: terms.version,
    },
  });
}
