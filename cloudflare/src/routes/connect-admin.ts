import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import type { ConnectBalance, ConnectGateway } from "../commerce/connect-gateway";
import { resolveConnectGateway } from "../commerce/connect-gateway";
import {
  createOrReuseConnectAccount,
  issueDashboardLoginLink,
  issueOnboardingLink,
  readTenantConnect,
  refreshConnectStatus,
  sellerConnectView,
} from "../commerce/connect-onboarding";
import { jsonResponse } from "../lib/http";
import { readCanonicalOrigins } from "../lib/origins";
import { enforceRateLimit } from "../lib/rate-limit";
import { rateLimitedResponse, routeNotFoundResponse } from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

/**
 * The seller's Stripe Connect surface (CP3-F; Firebase connectOnboarding.ts +
 * src/pages/admin/AdminPayments.jsx). Tenant-admin session + `X-Shop-Id`, like
 * every tenant-admin route; a platform user holding an acting-as grant is
 * admitted everywhere EXCEPT the dashboard login link. Every guard failure is
 * the opaque 404; state changes also require a same-origin request.
 *
 *   GET  /v1/admin/payments/connect
 *        200 { connect: SellerConnectView }                    D1 only, never Stripe
 *
 *   POST /v1/admin/payments/connect/account
 *        201 { connect }   this request created and recorded the account
 *        200 { connect }   the shop already has one (Stripe not called)
 *        202 { connect, accountCreation: "pending" } + Retry-After
 *                          another request is creating it, or Stripe's answer
 *                          was lost — ask again; the same account comes back
 *        409 connect_account_conflict   recorded nothing, a platform alert raised
 *        502 connect_account_refused    Stripe refused; the next call starts over
 *        404 Connect not enabled for the shop by the platform, or any guard
 *
 *   POST /v1/admin/payments/connect/onboarding-link
 *        200 { onboarding: { url, expiresAt } }   never stored, never logged
 *        409 connect_account_missing · 502 connect_unavailable · 404
 *
 *   POST /v1/admin/payments/connect/refresh
 *        200 { connect }   Stripe's current status written as facts (ordered)
 *        502 connect_unavailable · 404
 *
 *   POST /v1/admin/payments/connect/login-link
 *        200 { dashboard: { url } }     Express dashboard, charges enabled only
 *        409 connect_onboarding_incomplete · 502 connect_unavailable
 *        404 also for an ACTING-AS platform user (the link opens the seller's
 *            own Stripe dashboard — bank details, payouts — and Stripe's rule
 *            is that login links go only to the account holder)
 *
 *   GET  /v1/admin/payments/connect/balance          (CP5-WK, unit WF)
 *        200 { balance: { available: [{ currency, amountMinor }],
 *                         pending:   [{ currency, amountMinor }],
 *                         payoutSchedule: { interval, delayDays, monthlyAnchor,
 *                                           weeklyAnchor } | null,
 *                         retrievedAt } }
 *            the CONNECTED account's own balance at Stripe, read now (never
 *            stored), per currency; nothing of the platform's balance, fee or
 *            reserve, and no account id (the seller sees one number)
 *        409 connect_account_missing   no account yet (Stripe not called)
 *        502 connect_unavailable       Stripe refused or could not be reached
 *        429 rate_limited              the shared per-shop limiter
 *        404 Connect not enabled for the shop by the platform (dark, as the
 *            create and onboarding routes), no Connect gateway configured, or
 *            any guard. An ACTING-AS platform user IS admitted: a balance is
 *            amounts, not access — unlike the login link it opens nothing of
 *            the seller's Stripe account, and the platform reads every
 *            connected account's balance in its own Stripe dashboard anyway;
 *            Firebase's getConnectBalance let the platform read any shop's.
 *            A read: no same-origin requirement, no audit row.
 *
 * Every Stripe-calling seller request — the four POSTs and the balance read —
 * shares one per-shop limiter.
 */

export const ADMIN_CONNECT_PATH = "/v1/admin/payments/connect";
export const ADMIN_CONNECT_ACCOUNT_PATH = `${ADMIN_CONNECT_PATH}/account`;
export const ADMIN_CONNECT_ONBOARDING_LINK_PATH = `${ADMIN_CONNECT_PATH}/onboarding-link`;
export const ADMIN_CONNECT_REFRESH_PATH = `${ADMIN_CONNECT_PATH}/refresh`;
export const ADMIN_CONNECT_LOGIN_LINK_PATH = `${ADMIN_CONNECT_PATH}/login-link`;
export const ADMIN_CONNECT_BALANCE_PATH = `${ADMIN_CONNECT_PATH}/balance`;

/** Stripe-calling seller requests per shop per window (a person clicks a few times a minute). */
export const CONNECT_TENANT_LIMIT = 12;
export const CONNECT_TENANT_WINDOW_MS = 60_000;
export const CONNECT_TENANT_SCOPE = "connect-tenant";

/** How soon a pending creation is worth asking about again. */
const PENDING_RETRY_AFTER_SECONDS = 5;

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function unavailableResponse(): Response {
  return errorResponse(502, "connect_unavailable", "The payment provider could not be reached");
}

type Admitted = { gateway: ConnectGateway; principal: TenantAdminPrincipal };

/**
 * The shared gate of the four POSTs: session + shop, same-origin, (optionally)
 * no acting-as, a configured gateway, then the per-shop limiter — in that
 * order, so nothing about the surface leaks before the session is proven and
 * nothing reaches Stripe before the limiter.
 */
async function admitSellerPost(
  env: Env,
  request: Request,
  options: { refuseActingAs: boolean },
): Promise<Admitted | Response> {
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }
  if (options.refuseActingAs && principal.actingAs !== undefined) {
    return routeNotFoundResponse();
  }
  const gateway = resolveConnectGateway(env);
  if (gateway === null) {
    return routeNotFoundResponse();
  }
  const limit = await enforceRateLimit(env.DB, {
    key: principal.tenantId,
    limit: CONNECT_TENANT_LIMIT,
    now: Date.now(),
    scope: CONNECT_TENANT_SCOPE,
    windowMs: CONNECT_TENANT_WINDOW_MS,
  });
  if (!limit.allowed) {
    return rateLimitedResponse(limit.retryAfterSeconds);
  }
  return { gateway, principal };
}

export async function handleAdminConnectStatusRoute(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const row = await readTenantConnect(env.DB, principal.tenantId);
  return row === null ? routeNotFoundResponse() : jsonResponse({ connect: sellerConnectView(row) });
}

export async function handleAdminConnectAccountRoute(env: Env, request: Request): Promise<Response> {
  const admitted = await admitSellerPost(env, request, { refuseActingAs: false });
  if (admitted instanceof Response) {
    return admitted;
  }

  const outcome = await createOrReuseConnectAccount(env.DB, admitted.principal, {
    defaultApi: admitted.gateway.api,
    gatewayFor: (api) => (api === admitted.gateway.api ? admitted.gateway : resolveConnectGateway(env, api)),
  });

  switch (outcome.status) {
    case "created":
      return jsonResponse({ connect: sellerConnectView(outcome.row) }, 201);
    case "exists":
      return jsonResponse({ connect: sellerConnectView(outcome.row) }, 200);
    case "pending": {
      const response = jsonResponse(
        { accountCreation: "pending", connect: sellerConnectView(outcome.row) },
        202,
      );
      response.headers.set("Retry-After", PENDING_RETRY_AFTER_SECONDS.toString());
      return response;
    }
    case "refused":
      return errorResponse(502, "connect_account_refused", "The payment provider refused to create the account");
    case "conflict":
      return errorResponse(
        409,
        "connect_account_conflict",
        "The payment account could not be recorded; the platform has been notified",
      );
    default:
      return routeNotFoundResponse();
  }
}

export async function handleAdminConnectOnboardingLinkRoute(env: Env, request: Request): Promise<Response> {
  const admitted = await admitSellerPost(env, request, { refuseActingAs: false });
  if (admitted instanceof Response) {
    return admitted;
  }
  // Return URLs come from the canonical allowlist or nowhere: without it the
  // surface does not exist.
  const origins = readCanonicalOrigins(env);
  if (origins === null) {
    return routeNotFoundResponse();
  }

  const outcome = await issueOnboardingLink(env.DB, admitted.gateway, admitted.principal, origins, Date.now());
  switch (outcome.status) {
    case "ok": {
      const { expiresAt, url } = outcome.link;
      return jsonResponse({
        onboarding: { expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(), url },
      });
    }
    case "no_account":
      return errorResponse(409, "connect_account_missing", "Create the payment account first");
    case "gateway_error":
      return unavailableResponse();
    default:
      return routeNotFoundResponse();
  }
}

export async function handleAdminConnectRefreshRoute(env: Env, request: Request): Promise<Response> {
  const admitted = await admitSellerPost(env, request, { refuseActingAs: false });
  if (admitted instanceof Response) {
    return admitted;
  }
  const outcome = await refreshConnectStatus(env.DB, admitted.gateway, admitted.principal.tenantId);
  switch (outcome.status) {
    case "ok":
      return jsonResponse({ connect: sellerConnectView(outcome.row) });
    case "gateway_error":
      return unavailableResponse();
    default:
      return routeNotFoundResponse();
  }
}

export async function handleAdminConnectLoginLinkRoute(env: Env, request: Request): Promise<Response> {
  const admitted = await admitSellerPost(env, request, { refuseActingAs: true });
  if (admitted instanceof Response) {
    return admitted;
  }
  const outcome = await issueDashboardLoginLink(env.DB, admitted.gateway, admitted.principal, Date.now());
  switch (outcome.status) {
    case "ok":
      return jsonResponse({ dashboard: { url: outcome.url } });
    case "onboarding_incomplete":
      return errorResponse(409, "connect_onboarding_incomplete", "The payment account is not active yet");
    case "gateway_error":
      return unavailableResponse();
    default:
      return routeNotFoundResponse();
  }
}

/**
 * `GET /v1/admin/payments/connect/balance` (CP5-WK, unit WF). The guard order:
 * session + shop (acting-as admitted), a configured gateway, Connect enabled
 * for the shop — each the opaque 404 — then an account (409), the shared
 * limiter, and only then Stripe.
 */
export async function handleAdminConnectBalanceRoute(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const gateway = resolveConnectGateway(env);
  if (gateway === null) {
    return routeNotFoundResponse();
  }
  const tenant = await readTenantConnect(env.DB, principal.tenantId);
  if (tenant === null || tenant.connect_enabled !== 1) {
    return routeNotFoundResponse();
  }
  if (tenant.stripe_account_id === null) {
    return errorResponse(409, "connect_account_missing", "Create the payment account first");
  }
  const limit = await enforceRateLimit(env.DB, {
    key: principal.tenantId,
    limit: CONNECT_TENANT_LIMIT,
    now: Date.now(),
    scope: CONNECT_TENANT_SCOPE,
    windowMs: CONNECT_TENANT_WINDOW_MS,
  });
  if (!limit.allowed) {
    return rateLimitedResponse(limit.retryAfterSeconds);
  }

  let balance: ConnectBalance;
  try {
    balance = await gateway.retrieveBalance(tenant.stripe_account_id);
  } catch {
    return unavailableResponse();
  }
  // Named fields only: whatever else a gateway hands back never reaches the seller.
  return jsonResponse({
    balance: {
      available: balance.available.map(({ amountMinor, currency }) => ({ amountMinor, currency })),
      payoutSchedule:
        balance.payoutSchedule === null
          ? null
          : {
              delayDays: balance.payoutSchedule.delayDays,
              interval: balance.payoutSchedule.interval,
              monthlyAnchor: balance.payoutSchedule.monthlyAnchor,
              weeklyAnchor: balance.payoutSchedule.weeklyAnchor,
            },
      pending: balance.pending.map(({ amountMinor, currency }) => ({ amountMinor, currency })),
      retrievedAt: new Date().toISOString(),
    },
  });
}
