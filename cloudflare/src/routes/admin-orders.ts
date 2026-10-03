import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import { listAdminOrders, parseAdminOrderListQuery } from "../commerce/admin-order-list";
import type { FulfilmentChange } from "../commerce/fulfilment";
import { changeFulfilment, parseFulfilmentInput } from "../commerce/fulfilment";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

/**
 * The seller's orders (CP5-WB):
 *
 *   GET  /v1/admin/orders?status&fulfilment&since&until&q&cursor&limit
 *        200 { orders: [AdminOrderListRow], nextCursor, count, totalMinor }
 *        400 invalid_request (an unknown or malformed parameter)
 *   POST /v1/admin/orders/:orderId/fulfilment
 *        { to, trackingNumber?, carrier?, note? } + Idempotency-Key: <uuid>
 *        200 { fulfilment: { orderId, from, to, at, shipment } }
 *            (a replay of the same key and request adds `Idempotent-Replayed: true`)
 *        409 { error: { code: "fulfilment_not_allowed", reason, message } }
 *            reason ∈ order_closed | delivery_method | transition
 *                     | tracking_required | printer_ships
 *        409 conflict                   the key was used for another request
 *        400 invalid_request            the body is not exactly the shape above
 *        400 idempotency_key_required   no `Idempotency-Key: <uuid>`
 *
 * The detail (`GET /v1/admin/orders/:orderId`) stays in money-orders.ts; the
 * refund and cancel routes stay where they are. These two paths are exact, so
 * none of the four shadows another (test/admin-order-list.test.ts pins it).
 *
 * Guard order, as every tenant-admin surface: the live session + `X-Shop-Id`
 * membership (or acting-as grant: an operator may help) first; a state change
 * also needs a same-origin request; both before any body is read. Every
 * failure of either, a malformed or foreign order id, and a method the route
 * does not have are the one opaque 404.
 */

export const ADMIN_ORDERS_PATH = "/v1/admin/orders";
export const ADMIN_ORDER_FULFILMENT_ROUTE = "/v1/admin/orders/:orderId/fulfilment";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function handleAdminOrderListRoute(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null) {
    return routeNotFoundResponse();
  }
  const query = parseAdminOrderListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  return jsonResponse(await listAdminOrders(env.DB, principal.tenantId, query));
}

const REFUSAL_MESSAGE: Record<string, string> = {
  delivery_method: "The order's delivery method does not have this step",
  order_closed: "The order is cancelled or refunded",
  printer_ships: "The printer ships this order's printed items",
  tracking_required: "Another shipment needs a tracking number",
  transition: "The order cannot move to this step from where it is",
};

function changeResponse(change: FulfilmentChange, replayed: boolean): Response {
  const response = jsonResponse({ fulfilment: change }, 200);
  if (replayed) {
    response.headers.set("Idempotent-Replayed", "true");
  }
  return response;
}

export async function handleAdminOrderFulfilmentRoute(
  env: Env,
  request: Request,
  rawOrderId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const principal = await authorizeTenantAdminRequest(env, request);
  if (principal === null || !isSameOriginRequest(request)) {
    return routeNotFoundResponse();
  }
  const decoded = decodeSegment(rawOrderId);
  if (decoded === null || !UUID_PATTERN.test(decoded)) {
    return routeNotFoundResponse();
  }

  const keyRaw = request.headers.get("idempotency-key")?.trim() ?? null;
  if (keyRaw === null || !IDEMPOTENCY_KEY_PATTERN.test(keyRaw)) {
    return jsonResponse(
      {
        error: {
          code: "idempotency_key_required",
          message: "An Idempotency-Key header (a UUID) is required",
        },
      },
      400,
    );
  }

  const input = parseFulfilmentInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await changeFulfilment(
    env.DB,
    principal,
    decoded,
    input,
    keyRaw.toLowerCase(),
    Date.now(),
  );
  switch (result.status) {
    case "changed":
      return changeResponse(result.change, false);
    case "replayed":
      return changeResponse(result.change, true);
    case "refused":
      return jsonResponse(
        {
          error: {
            code: "fulfilment_not_allowed",
            message: REFUSAL_MESSAGE[result.reason] ?? "Not allowed",
            reason: result.reason,
          },
        },
        409,
      );
    case "key_conflict":
      return jsonResponse(
        {
          error: {
            code: "conflict",
            message: "Idempotency key was already used for a different request",
          },
        },
        409,
      );
    default:
      return routeNotFoundResponse();
  }
}
