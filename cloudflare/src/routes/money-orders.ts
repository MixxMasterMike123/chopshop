import { authorizeTenantAdminRequest } from "../auth/request-authorization";
import { readAdminOrder } from "../commerce/admin-orders";
import { pendingPrinterCancellationIds } from "../commerce/dispatch-hold";
import { readAdminOrderConsent } from "../legal/consent";
import { nudgeOutbox } from "../outbox/nudge";
import type { RefundRequestInput, RefundState } from "../commerce/refunds";
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
import { readAdminOrderWithdrawal } from "../commerce/withdrawals";

/**
 * The tenant-admin money surface (CP2-A):
 *
 *   GET  /v1/admin/orders/:orderId          the order's money facts + payout
 *                                           + the buyer's consent facts (CP2-E)
 *   POST /v1/admin/orders/:orderId/refunds  { amountMinor, reason }
 *                                           + header Idempotency-Key: <uuid> (CP2-E)
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
  if (order === null) {
    return routeNotFoundResponse();
  }
  // CP2-E: what the buyer consented to at checkout (src/legal/consent.ts) —
  // terms, the separate marketing box, and a waived right of withdrawal.
  const consent = await readAdminOrderConsent(env.DB, principal.tenantId, orderId);
  return jsonResponse({
    order: {
      ...order,
      consent: consent?.consent ?? null,
      withdrawal: { waived: consent?.isPersonalized ?? false },
      // CP4-G: the buyer's withdrawal on record for this order, with the
      // server's time of receipt; null when there is none.
      withdrawalRequest: await readAdminOrderWithdrawal(env.DB, principal.tenantId, orderId),
    },
  });
}

/** Idempotency-Key: a UUID, compared lowercase. */
const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseIdempotencyKeyHeader(value: string | null): string | null {
  return value !== null && IDEMPOTENCY_KEY_PATTERN.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

interface ClientRefundRow {
  amount_minor: number;
  id: string;
  order_id: string;
  reason: string | null;
  state: RefundState;
}

async function findClientRefund(
  db: D1Database,
  tenantId: string,
  clientKey: string,
): Promise<ClientRefundRow | null> {
  return db
    .prepare(
      `SELECT id, order_id, amount_minor, reason, state
       FROM refund_operations
       WHERE tenant_id = ? AND client_key = ?
       LIMIT 1`,
    )
    .bind(tenantId, clientKey)
    .first<ClientRefundRow>();
}

function isClientKeyCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("UNIQUE constraint failed") &&
    message.includes("refund_operations.client_key")
  );
}

/**
 * The answer for a key already used: the SAME operation, as it stands now
 * (202 while its reservation is unsettled, 201 otherwise — the original's
 * mapping), when the request is the same; 409 when the key names a different
 * order, amount or reason.
 */
function replayResponse(
  existing: ClientRefundRow,
  orderId: string,
  input: RefundRequestInput,
): Response {
  if (
    existing.order_id !== orderId ||
    existing.amount_minor !== input.amountMinor ||
    existing.reason !== input.reason
  ) {
    return jsonResponse(
      {
        error: {
          code: "conflict",
          message: "Idempotency key was already used for a different request",
        },
      },
      409,
    );
  }
  const response = jsonResponse(
    {
      refund: {
        amountMinor: existing.amount_minor,
        refundId: existing.id,
        state: existing.state,
      },
    },
    existing.state === "reserved" ? 202 : 201,
  );
  response.headers.set("Idempotent-Replayed", "true");
  return response;
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
 *   400 idempotency_key_required                       no `Idempotency-Key: <uuid>`
 *   409 conflict                                       the key was used for a
 *       different order / amount / reason
 *
 * CLIENT IDEMPOTENCY (CP2-E): the key is stored on the operation inside the
 * reservation batch, UNIQUE per tenant. A retry after a lost response (a
 * network error, a double click) answers with the FIRST operation — same
 * refundId, its current state, header `Idempotent-Replayed: true` — and never
 * creates a second real refund. Two concurrent requests with one key: one
 * reservation commits; the other either aborts on the index or is refused by
 * the balance the first one reserved — both paths re-read the key and replay
 * the winner, so neither caller ever sees a refusal of an accepted refund.
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

  const clientKey = parseIdempotencyKeyHeader(request.headers.get("idempotency-key"));
  if (clientKey === null) {
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

  const input = parseRefundRequestInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const existing = await findClientRefund(env.DB, principal.tenantId, clientKey);
  if (existing !== null) {
    return replayResponse(existing, orderId, input);
  }

  let outcome;
  try {
    outcome = await requestRefund(
      env.DB,
      resolveStripeMoneyGateway(env),
      principal,
      orderId,
      input,
      Date.now(),
      { clientKey },
    );
  } catch (error) {
    // A concurrent request with the same key reserved first: this batch
    // aborted whole (nothing reserved), so answer with that operation.
    if (!isClientKeyCollision(error)) {
      throw error;
    }
    const winner = await findClientRefund(env.DB, principal.tenantId, clientKey);
    if (winner === null) {
      throw error;
    }
    return replayResponse(winner, orderId, input);
  }

  // Not ours to answer yet: a concurrent request with the SAME key may have
  // reserved first — e.g. the full remainder, so this one was refused
  // (`not_allowed`, at once or after losing the version race) before its
  // insert could ever hit the unique index. Whenever the key now names an
  // operation, the caller's refund WAS accepted: replay it (Codex P2 on
  // CP2-E). A key that names nothing keeps the refusal.
  if (outcome.status !== "created" && outcome.status !== "pending") {
    const accepted = await findClientRefund(env.DB, principal.tenantId, clientKey);
    if (accepted !== null) {
      return replayResponse(accepted, orderId, input);
    }
  }

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
