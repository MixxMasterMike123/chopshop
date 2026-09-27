import { authorizePlatformRequest } from "../auth/request-authorization";
import { resolveConnectGateway } from "../commerce/connect-gateway";
import {
  listOnboardingOperations,
  parsePayoutDelayInput,
  platformConnectView,
  readTenantConnect,
  setConnectEnabled,
  setPayoutDelay,
} from "../commerce/connect-onboarding";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";
import { parseTenantIdPathSegment } from "../platform/provision-tenants";

/**
 * The platform's Stripe Connect controls for one shop (CP3-F; Firebase
 * connectOnboarding.ts setConnectPayoutDelay + the `payments.connectEnabled`
 * opt-in). Platform session only; POST/PUT also same-origin. Every guard
 * failure and an unknown shop is the opaque 404.
 *
 *   GET  /v1/platform/tenants/:tenantId/connect
 *        200 { connect: PlatformConnectView, operations: ConnectOperationView[] }
 *   POST /v1/platform/tenants/:tenantId/connect/enable     200 { connect }  audited
 *   POST /v1/platform/tenants/:tenantId/connect/disable    200 { connect }  audited
 *        Disabling closes the seller's create + onboarding-link routes. It does
 *        not touch Stripe or the account, and it does NOT stop checkout: the
 *        payment gate keys on the account's charges_enabled only.
 *   PUT  /v1/platform/tenants/:tenantId/connect/payout-delay  { delayDays: 0..365 | "minimum" }
 *        200 { connect }  Stripe accepted it, then it was stored + audited
 *        409 connect_account_missing · 422 connect_payout_delay_refused (Stripe
 *        refused, e.g. below the country minimum) · 502 connect_unavailable ·
 *        400 invalid_request
 *
 * These paths sit under the tenant prefix whose older handler is POST-only
 * with a terminal 404, so app.ts registers them as exact paths with
 * `onMethods` ahead of it. The tenant segment arrives RAW and is decoded once.
 */

export const PLATFORM_CONNECT_ROUTE = "/v1/platform/tenants/:tenantId/connect";
export const PLATFORM_CONNECT_ENABLE_ROUTE = `${PLATFORM_CONNECT_ROUTE}/enable`;
export const PLATFORM_CONNECT_DISABLE_ROUTE = `${PLATFORM_CONNECT_ROUTE}/disable`;
export const PLATFORM_CONNECT_PAYOUT_DELAY_ROUTE = `${PLATFORM_CONNECT_ROUTE}/payout-delay`;

export type PlatformConnectAction = "disable" | "enable" | "payout_delay" | "read";

const ACTION_METHOD: Record<PlatformConnectAction, string> = {
  disable: "POST",
  enable: "POST",
  payout_delay: "PUT",
  read: "GET",
};

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export async function handlePlatformConnectRoute(
  env: Env,
  request: Request,
  rawTenantId: string,
  action: PlatformConnectAction,
): Promise<Response> {
  if (request.method !== ACTION_METHOD[action]) {
    return routeNotFoundResponse();
  }
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || (action !== "read" && !isSameOriginRequest(request))) {
    return routeNotFoundResponse();
  }
  const decoded = decodeSegment(rawTenantId);
  const tenantId = decoded === null ? null : parseTenantIdPathSegment(decoded);
  if (tenantId === null) {
    return routeNotFoundResponse();
  }
  const now = Date.now();

  if (action === "read") {
    const row = await readTenantConnect(env.DB, tenantId);
    if (row === null) {
      return routeNotFoundResponse();
    }
    return jsonResponse({
      connect: platformConnectView(row),
      operations: await listOnboardingOperations(env.DB, tenantId),
    });
  }

  if (action === "enable" || action === "disable") {
    const outcome = await setConnectEnabled(env.DB, principal, tenantId, action === "enable", now);
    return outcome.status === "ok"
      ? jsonResponse({ connect: platformConnectView(outcome.row) })
      : routeNotFoundResponse();
  }

  const input = parsePayoutDelayInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }
  const gateway = resolveConnectGateway(env);
  if (gateway === null) {
    return routeNotFoundResponse();
  }
  const outcome = await setPayoutDelay(env.DB, gateway, principal, tenantId, input, now);
  switch (outcome.status) {
    case "ok":
      return jsonResponse({ connect: platformConnectView(outcome.row) });
    case "no_account":
      return errorResponse(409, "connect_account_missing", "The shop has no payment account yet");
    case "refused":
      return errorResponse(422, "connect_payout_delay_refused", "The payment provider refused the payout delay");
    case "gateway_error":
      return errorResponse(502, "connect_unavailable", "The payment provider could not be reached");
    default:
      return routeNotFoundResponse();
  }
}
