import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import { cancelOrder, parseCancelOrderInput } from "../dispatch/cancellation";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

export const ADMIN_ORDER_CANCEL_ROUTE = "/v1/admin/orders/:orderId/cancel";

const ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `POST /v1/admin/orders/{orderId}/cancel` `{ reason }` — cancel an order's
 * production (PLAN §2.3 "Cancellation vs dispatch"; the four paths live in
 * src/dispatch/cancellation.ts).
 *
 *   200 { cancellation: { orderId, cancelledAt, reason,
 *                         lines: [{ lineNo, jobId, outcome }] } }
 *       outcome ∈ cancelled | cancel_requested | printer_cancellation
 *                 | awaiting_resolution | not_at_printer
 *       Idempotent: repeating it answers the recorded cancellation.
 *   409 { error: { code: "return_case", … } } — something was produced already
 *   400 invalid body · 404 everything else (same opaque 404 as every admin route)
 *
 * Tenant admin (membership or acting-as), same-origin, the shop from
 * `X-Shop-Id`. An order of another shop is a 404. Moves NO money: the refund is
 * CP2-A's separate call.
 */
export async function handleAdminOrderCancelRoute(
  env: Env,
  request: Request,
  rawOrderId: string,
): Promise<Response> {
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || !isSameOriginRequest(request) || request.method !== "POST") {
    return routeNotFoundResponse();
  }

  const orderId = decodeSegment(rawOrderId);
  if (orderId === null || !ORDER_ID_PATTERN.test(orderId)) {
    return routeNotFoundResponse();
  }

  const input = parseCancelOrderInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await cancelOrder(env, principal, { orderId, reason: input.reason }, Date.now());
  if (result.status === "not_found") {
    return routeNotFoundResponse();
  }
  if (result.status === "return_case") {
    return jsonResponse(
      {
        error: {
          code: "return_case",
          message: "The order has been produced; handle it as a return",
        },
      },
      409,
    );
  }
  return jsonResponse({ cancellation: result.cancellation }, 200);
}
