import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import { readAdminOrder } from "../commerce/admin-orders";
import { pendingPrinterCancellationIds } from "../commerce/dispatch-hold";
import { nudgeOutbox } from "../outbox/nudge";
import { parseRefundRequestInput, requestRefund } from "../commerce/refunds";
import {
  isStripeConfigured,
  resolveStripeMoneyGateway,
} from "../commerce/stripe-client";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

/**
 * The tenant-admin money surface (CP2-A):
 *
 *   GET  /v1/admin/orders/:orderId          the order's money facts + payout
 *   POST /v1/admin/orders/:orderId/refunds  { amountMinor, reason }
 *
 * Same guard order as every tenant-admin surface: the live session +
 * `X-Shop-Id` membership (or acting-as grant) check runs first, and a state
 * change also needs a same-origin request, both before any body is read. Every
 * failure of either is the one opaque 404, as is an order id of another shop,
 * a malformed one, or a method the route does not have.
 */

export const ADMIN_ORDER_ROUTE = "/v1/admin/orders/:orderId";
export const ADMIN_ORDER_REFUNDS_ROUTE = "/v1/admin/orders/:orderId/refunds";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function orderIdFromSegment(rawOrderId: string): string | null {
  const decoded = decodeSegment(rawOrderId);
  return decoded !== null && UUID_PATTERN.test(decoded) ? decoded : null;
}

export async function handleAdminOrderRoute(
  env: Env,
  request: Request,
  rawOrderId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }

  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }

  const orderId = orderIdFromSegment(rawOrderId);
  if (orderId === null) {
    return routeNotFoundResponse();
  }

  const order = await readAdminOrder(env.DB, principal, orderId, Date.now());
  return order === null
    ? routeNotFoundResponse()
    : jsonResponse({ order });
}

/**
 * Responses:
 *   201 { refund: { refundId, amountMinor, state } }  Stripe answered — state
 *       is 'submitted', 'succeeded' or 'failed' (Stripe refused; the
 *       reservation was released)
 *   202 { refund: { …, state: "reserved" } }          Stripe's outcome is
 *       unknown; the reservation holds and the webhook or the reconciliation
 *       cron settles it (or releases it after 30 min if Stripe never got it)
 *   409 refund_not_allowed                             more than remains, a
 *       disputed charge, or the order's refunds kept changing under it
 *   400 invalid_request                                body is not exactly
 *       { amountMinor: positive integer, reason: 1–500 chars }
 *   404                                                everything else,
 *       including an unconfigured Stripe key (the surface is dark)
 */
export async function handleAdminOrderRefundsRoute(
  env: Env,
  request: Request,
  rawOrderId: string,
): Promise<Response> {
  if (!isStripeConfigured(env) || request.method !== "POST") {
    return routeNotFoundResponse();
  }

  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }

  const orderId = orderIdFromSegment(rawOrderId);
  if (orderId === null) {
    return routeNotFoundResponse();
  }

  const input = parseRefundRequestInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const outcome = await requestRefund(
    env.DB,
    resolveStripeMoneyGateway(env),
    principal,
    orderId,
    input,
    Date.now(),
  );

  // A full refund of a job the printer already accepted queued a
  // printer_cancellation in the settlement batch: nudge it now, rather than
  // leave it for the next 15-minute sweep while the job may be printing.
  if (outcome.status === "created") {
    await nudgeOutbox(env, await pendingPrinterCancellationIds(env.DB, [orderId]));
  }

  switch (outcome.status) {
    case "created":
      return jsonResponse({ refund: outcome.refund }, 201);
    case "pending":
      return jsonResponse({ refund: outcome.refund }, 202);
    case "not_allowed":
      return jsonResponse(
        {
          error: {
            code: "refund_not_allowed",
            message: "The order cannot be refunded by this amount",
          },
        },
        409,
      );
    default:
      return routeNotFoundResponse();
  }
}
