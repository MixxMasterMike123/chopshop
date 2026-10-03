import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import {
  acceptLegalPages,
  LEGAL_BODY_MAX_BYTES,
  parseAcceptPagesInput,
  readJsonBodyWithin,
  readLatestLegalPagesAcceptance,
  readLegalReadiness,
} from "../legal/legal-pages";
import {
  acceptPlatformTerms,
  maySignForSeller,
  parseAcceptTermsInput,
  readLatestTermsAcceptance,
  readTermsStatus,
  readTermsText,
} from "../legal/platform-terms";
import { jsonResponse } from "../lib/http";
import { clientIp } from "../lib/rate-limit";
import {
  invalidRequestResponse,
  rateLimitedResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

/**
 * The shop admin's legal surface (CP2-E migrations/0031, CP3-E 0037):
 *
 *   GET  /v1/admin/legal/status        (an acting-as platform user may read it)
 *        200 { currentVersion: string | null, accepted: boolean, acceptedAt: string | null,
 *              acceptedVersion: string | null, inGrace: boolean, graceDeadline: string | null,
 *              readiness: { returnAddress, vatAnswered, legalPagesAccepted, ready },
 *              latestAcceptance: { version, acceptedAt, acceptedBy } | null }
 *        Always this shape. acceptedVersion = the latest version the shop accepted;
 *        latestAcceptance = that acceptance: its version, time (server clock) and
 *        signer (src/legal/signer.ts: { kind: "admin", name, email } — a person
 *        of the shop — or { kind: "platform", name: null, email: null });
 *        graceDeadline is set when it accepted the version right before the current
 *        one (also once passed; inGrace then false). `readiness` is the legal
 *        readiness gate (booleans only — never the address itself): why a shop
 *        whose terms are fine still takes no checkout.
 *
 *   POST /v1/admin/legal/accept-terms   { termsVersion }
 *        201 { acceptance: { termsVersion, acceptedAt } }   recorded now
 *        200 { acceptance: { termsVersion, acceptedAt } }   already accepted (the first one)
 *        409 { error: { code: "terms_version_not_current", … }, currentVersion }
 *        400 invalid_request                                 body is not exactly { termsVersion }
 *
 *   GET  /v1/admin/legal/terms
 *        200 { version, sha256, publishedAt, textArchived, text }   the CURRENT version only;
 *            text null + textArchived false when no text is archived for it; all null
 *            when no version is published
 *
 *   GET  /v1/admin/legal/pages
 *        200 { acceptance: PagesAcceptanceView | null }   the latest legal-pages adoption,
 *            with `acceptedBy` (the signer, as in the status) and `acceptedAt`
 *
 *   POST /v1/admin/legal/accept-pages   { templateVersion, texts: { kopvillkor, angerratt,
 *                                          integritetspolicy }, pod, custom }
 *        custom = a boolean, or the per-page map { kopvillkor, angerratt, integritetspolicy }
 *        of booleans (then stored as custom_json and summarised as custom)
 *        201 { acceptance: { acceptanceId, acceptedAt, templateVersion, textsSha256, pod,
 *                            custom, customPages } }
 *        400 invalid_request                               a malformed body
 *        400 { error: { code: "invalid_request", page, pages, reason } }
 *            a well-formed body whose HTML html-refusal.ts refuses: `page` the
 *            first refused page key (angerratt, integritetspolicy, kopvillkor
 *            order), `pages` every refused key, `reason` the first one's refusal
 *        413 payload_too_large · 429 rate_limited
 *
 *   404  everything else — no session, no membership, cross-origin on a POST,
 *        and an ACTING-AS platform user on either accept route (the seller
 *        signs, never the platform on the seller's behalf; it may read).
 *
 * Tenant = `X-Shop-Id` checked against the session's memberships, like every
 * tenant-admin surface; the state changes also require a same-origin request.
 */

export const ADMIN_LEGAL_STATUS_PATH = "/v1/admin/legal/status";
export const ADMIN_LEGAL_ACCEPT_TERMS_PATH = "/v1/admin/legal/accept-terms";
export const ADMIN_LEGAL_TERMS_PATH = "/v1/admin/legal/terms";
export const ADMIN_LEGAL_PAGES_PATH = "/v1/admin/legal/pages";
export const ADMIN_LEGAL_ACCEPT_PAGES_PATH = "/v1/admin/legal/accept-pages";

/**
 * The guard of every seller acceptance: a tenant admin of the named shop, a
 * same-origin request, and `maySignForSeller` (no acting-as platform user).
 */
async function authorizeSellerSignature(
  env: Env,
  request: Request,
): Promise<TenantAdminPrincipal | null> {
  const principal = await authorizeTenantAdminRequest(env, request);
  return principal === null || !isSameOriginRequest(request) || !maySignForSeller(principal)
    ? null
    : principal;
}

function payloadTooLargeResponse(): Response {
  return jsonResponse(
    { error: { code: "payload_too_large", message: "The texts exceed the maximum allowed size" } },
    413,
  );
}

export async function handleAdminLegalStatusRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  const now = Date.now();
  const [status, readiness, latestAcceptance] = await Promise.all([
    readTermsStatus(env.DB, principal.tenantId, now),
    readLegalReadiness(env.DB, principal.tenantId),
    readLatestTermsAcceptance(env.DB, principal.tenantId, now, "shop"),
  ]);
  return jsonResponse({
    accepted: status.acceptedAt !== null,
    acceptedAt: status.acceptedAt,
    acceptedVersion: status.acceptedVersion,
    currentVersion: status.currentVersion,
    graceDeadline: status.graceDeadline,
    inGrace: status.inGrace,
    latestAcceptance,
    readiness,
  });
}

export async function handleAdminLegalAcceptTermsRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeSellerSignature(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  const input = parseAcceptTermsInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await acceptPlatformTerms(
    env.DB,
    principal,
    input,
    {
      ip: request.headers.has("cf-connecting-ip") ? clientIp(request) : null,
      origin: request.headers.get("origin"),
      userAgent: request.headers.get("user-agent"),
    },
    Date.now(),
  );

  switch (result.status) {
    case "accepted":
      return jsonResponse({ acceptance: result.acceptance }, 201);
    case "already_accepted":
      return jsonResponse({ acceptance: result.acceptance }, 200);
    case "not_current":
      return jsonResponse(
        {
          currentVersion: result.currentVersion,
          error: {
            code: "terms_version_not_current",
            message: "The terms version is not the current one",
          },
        },
        409,
      );
    default:
      return routeNotFoundResponse();
  }
}

/** The text the seller is asked to accept: the CURRENT version, and only it. */
export async function handleAdminLegalTermsRoute(env: Env, request: Request): Promise<Response> {
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  const status = await readTermsStatus(env.DB, principal.tenantId, Date.now());
  if (status.currentVersion === null) {
    return jsonResponse({ publishedAt: null, sha256: null, text: null, textArchived: false, version: null });
  }
  const read = await readTermsText(env.DB, env.PRIVATE_BUCKET, status.currentVersion);
  if (read.status !== "ok") {
    // Versions are append-only: the current one cannot vanish between reads.
    throw new Error(`current terms version ${status.currentVersion} not found`);
  }
  return jsonResponse({
    publishedAt: read.publishedAt,
    sha256: read.sha256,
    text: read.text,
    textArchived: read.text !== null,
    version: read.version,
  });
}

export async function handleAdminLegalPagesRoute(env: Env, request: Request): Promise<Response> {
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  return jsonResponse({ acceptance: await readLatestLegalPagesAcceptance(env.DB, principal.tenantId) });
}

export async function handleAdminLegalAcceptPagesRoute(env: Env, request: Request): Promise<Response> {
  const principal = await authorizeSellerSignature(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  const body = await readJsonBodyWithin(request, LEGAL_BODY_MAX_BYTES);
  if (body.status === "too_large") {
    return payloadTooLargeResponse();
  }
  const parsed = parseAcceptPagesInput(body.value);
  if (parsed.status === "invalid") {
    return invalidRequestResponse();
  }
  if (parsed.status === "content_refused") {
    // The code stays `invalid_request` (the answer the page already handles);
    // `page`/`pages` name the refused texts, `reason` why (html-refusal.ts).
    return jsonResponse(
      {
        error: {
          code: "invalid_request",
          message: "A text holds markup that cannot be published",
          page: parsed.page,
          pages: parsed.pages,
          reason: parsed.reason,
        },
      },
      400,
    );
  }

  const result = await acceptLegalPages(
    env.DB,
    principal,
    parsed.input,
    {
      ip: request.headers.has("cf-connecting-ip") ? clientIp(request) : null,
      userAgent: request.headers.get("user-agent"),
    },
    Date.now(),
  );

  switch (result.status) {
    case "accepted":
      return jsonResponse({ acceptance: result.acceptance }, 201);
    case "too_large":
      return payloadTooLargeResponse();
    case "rate_limited":
      return rateLimitedResponse(result.retryAfterSeconds);
    default:
      return routeNotFoundResponse();
  }
}
