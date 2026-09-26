import {
  claimReceiptHandoff,
  parseReceiptBearer,
  readBuyerOrder,
} from "../commerce/receipts";
import { jsonResponse } from "../lib/http";
import { clientIp, enforceRateLimit } from "../lib/rate-limit";
import {
  decodeSegment,
  notFoundResponse,
  rateLimitedResponse,
} from "../lib/responses";
import { resolveRequestTenant } from "../tenancy/resolve-tenant";

export const RECEIPT_CLAIM_ROUTE = "/v1/checkout/:checkoutId/receipt";
export const BUYER_ORDER_ROUTE = "/v1/orders/:orderId";

const MINUTE_MS = 60 * 1_000;

/**
 * The confirmation poll's shield. The storefront polls every 2 s for up to
 * 90 s (PLAN §2.9) — 30 requests a minute from one honest buyer — so the limit
 * sits at twice that, which still bounds an anonymous caller to one D1 write
 * and one read a second.
 */
export const RECEIPT_CLAIM_IP_SCOPE = "receipt-claim-ip";
export const RECEIPT_CLAIM_IP_LIMIT = 60;
export const RECEIPT_CLAIM_IP_WINDOW_MS = MINUTE_MS;

/**
 * The receipt read's shield. A buyer reads their order a handful of times; the
 * limit exists so a caller holding a guessed order id cannot turn this route
 * into a token oracle at line rate. (A 256-bit token is not guessable anyway —
 * this bounds the cost of trying, not the odds.)
 */
export const ORDER_READ_IP_SCOPE = "order-read-ip";
export const ORDER_READ_IP_LIMIT = 30;
export const ORDER_READ_IP_WINDOW_MS = MINUTE_MS;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * ONE opaque 404 for every miss on both routes — unknown ids, another shop's
 * hostname, a wrong, missing, malformed or expired token — for the reason the
 * payment route gives: a capability route that distinguished "never existed"
 * from "exists but not for you" would confirm the ids an attacker is probing.
 */
function receiptNotFoundResponse(): Response {
  return notFoundResponse("Order not found");
}

/**
 * `POST /v1/checkout/{checkoutId}/receipt` — the confirmation poll.
 *
 * Tenant from the hostname, the checkout id as the capability (exactly the
 * trust model of the payment route beside it). No body is read. Answers:
 *   200 { receipt: { status: "pending" } }                       keep polling
 *   200 { receipt: { status: "ready", orderId, receiptToken } }  ONCE
 *   200 { receipt: { status: "issued" } }                        already handed out
 *   404                                                          anything else
 * POST rather than GET because a successful call consumes the token: a GET that
 * deleted state would be one prefetch away from losing a buyer's receipt.
 */
export async function handleReceiptClaimRoute(
  env: Env,
  request: Request,
  rawCheckoutId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return receiptNotFoundResponse();
  }

  const checkoutId = decodeSegment(rawCheckoutId);
  if (checkoutId === null) {
    return receiptNotFoundResponse();
  }

  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return receiptNotFoundResponse();
  }

  const now = Date.now();
  const byIp = await enforceRateLimit(env.DB, {
    key: clientIp(request),
    limit: RECEIPT_CLAIM_IP_LIMIT,
    now,
    scope: RECEIPT_CLAIM_IP_SCOPE,
    windowMs: RECEIPT_CLAIM_IP_WINDOW_MS,
  });
  if (!byIp.allowed) {
    return rateLimitedResponse(byIp.retryAfterSeconds);
  }

  const claim = await claimReceiptHandoff(env.DB, tenant.tenantId, checkoutId, now);
  if (claim.status === "not_found") {
    return receiptNotFoundResponse();
  }

  // jsonResponse sets no-store; this body carries a bearer credential.
  return jsonResponse({
    receipt:
      claim.status === "ready"
        ? {
            orderId: claim.orderId,
            receiptToken: claim.receiptToken,
            status: "ready",
          }
        : { status: claim.status },
  });
}

/**
 * `GET /v1/orders/{orderId}` with `Authorization: Bearer <receiptToken>`.
 *
 * Tenant from the hostname; the token must be the one minted for THIS order in
 * THIS shop and unexpired. The answer is the allowlisted buyer schema
 * (src/commerce/receipts.ts) and nothing else.
 *
 * The limiter counts every well-formed request that reaches a real storefront,
 * token or not, so trying tokens costs the same as reading.
 */
export async function handleBuyerOrderRoute(
  env: Env,
  request: Request,
  rawOrderId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return receiptNotFoundResponse();
  }

  const orderId = decodeSegment(rawOrderId);
  if (orderId === null || !UUID_PATTERN.test(orderId)) {
    return receiptNotFoundResponse();
  }

  const tenant = await resolveRequestTenant(env.DB, request);
  if (tenant === null) {
    return receiptNotFoundResponse();
  }

  const now = Date.now();
  const byIp = await enforceRateLimit(env.DB, {
    key: clientIp(request),
    limit: ORDER_READ_IP_LIMIT,
    now,
    scope: ORDER_READ_IP_SCOPE,
    windowMs: ORDER_READ_IP_WINDOW_MS,
  });
  if (!byIp.allowed) {
    return rateLimitedResponse(byIp.retryAfterSeconds);
  }

  const token = parseReceiptBearer(request.headers.get("authorization"));
  if (token === null) {
    return receiptNotFoundResponse();
  }

  const order = await readBuyerOrder(env.DB, tenant.tenantId, orderId, token, now);
  return order === null ? receiptNotFoundResponse() : jsonResponse({ order });
}
