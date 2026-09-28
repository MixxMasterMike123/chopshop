import { authorizePlatformRequest } from "../auth/request-authorization";
import type { Payout, PayoutFacts } from "../commerce/payouts";
import { computePayout, PAYOUT_FACT_COLUMNS } from "../commerce/payouts";
import {
  isAlertId,
  listAlerts,
  parseAlertListQuery,
  parseResolveAlertInput,
  resolveAlert,
} from "../commerce/money-alerts";
import { readOrderRecipients, type RecipientView } from "../commerce/recipient";
import { jsonResponse } from "../lib/http";
import {
  decodeSegment,
  invalidRequestResponse,
  readJsonBody,
  routeNotFoundResponse,
} from "../lib/responses";
import { isSameOriginRequest } from "../lib/same-origin";

/**
 * The platform's read surfaces over orders and alerts (CP2-E) — what an
 * operator (and scripts/cf-port/reconcile-staging.mjs) needs instead of a D1
 * export. Platform principal only; a GET needs no same-origin (as for every
 * admin read), the resolve POST does.
 *
 *   GET  /v1/platform/orders?tenantId=…[&since=ISO][&cursor=…][&limit=1..100]
 *        200 { orders: [PlatformOrderView], nextCursor: string | null }
 *   GET  /v1/platform/alerts?state=open|resolved[&kind][&tenantId][&cursor][&limit]
 *        200 { alerts: [AlertView], nextCursor: string | null }
 *   POST /v1/platform/alerts/:alertId/resolve   { note }
 *        200 { alert: AlertView } · 409 conflict (already resolved) · 404 unknown
 *
 * PLATFORM-ONLY, so the order view carries what no seller or buyer surface
 * may: the Stripe ids, the gross application fee and its withholding split,
 * the production cost and the printer. Still no card data (none is stored)
 * and no buyer email. It does carry the order's `recipient` (D98, brief R):
 * the platform places the printer's job and answers for its delivery, so its
 * operator must be able to see where an order goes.
 */

export const PLATFORM_ORDERS_PATH = "/v1/platform/orders";
export const PLATFORM_ALERTS_PATH = "/v1/platform/alerts";
export const PLATFORM_ALERT_RESOLVE_ROUTE = "/v1/platform/alerts/:alertId/resolve";

export const ORDER_LIST_LIMIT = 50;
const MAX_ORDER_LIST_LIMIT = 100;
/** D1 bound-parameter budget (PLAN §2.7): IN (…) lists are chunked. */
const IN_CHUNK = 90;
const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ORDER_CURSOR_PATTERN =
  /^(\d{1,16})~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

interface OrderListQuery {
  cursor: { createdAt: number; orderId: string } | null;
  limit: number;
  since: number | null;
  tenantId: string;
}

/**
 * `tenantId` is REQUIRED: every read stays on the tenant-first index
 * (orders_tenant_created_idx), as PLAN §2.7 asks of tenant tables.
 */
function parseOrderListQuery(url: URL): OrderListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!["cursor", "limit", "since", "tenantId"].includes(key)) {
      return null;
    }
  }
  const tenantId = params.get("tenantId");
  if (tenantId === null || !TENANT_PATTERN.test(tenantId)) {
    return null;
  }
  const sinceRaw = params.get("since");
  let since: number | null = null;
  if (sinceRaw !== null) {
    since = ISO_PATTERN.test(sinceRaw) ? Date.parse(sinceRaw) : Number.NaN;
    if (!Number.isFinite(since)) {
      return null;
    }
  }
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? ORDER_LIST_LIMIT : Number(limitRaw);
  if (!/^\d{1,3}$/.test(limitRaw ?? "50") || limit < 1 || limit > MAX_ORDER_LIST_LIMIT) {
    return null;
  }
  const cursorRaw = params.get("cursor");
  let cursor: OrderListQuery["cursor"] = null;
  if (cursorRaw !== null) {
    const match = ORDER_CURSOR_PATTERN.exec(cursorRaw);
    if (match === null) {
      return null;
    }
    cursor = { createdAt: Number(match[1]), orderId: match[2] as string };
  }
  return { cursor, limit, since, tenantId };
}

export interface PlatformOrderView {
  cancelledAt: string | null;
  connectAccountId: string | null;
  createdAt: string;
  currency: string;
  deliveryMethod: string;
  dispatch: Array<{
    attempts: number;
    lastError: string | null;
    lineNo: number | null;
    outboxId: string;
    printerJobRef: string | null;
    state: string;
  }>;
  isPersonalized: boolean;
  money: {
    applicationFeeMinor: number;
    chargedMinor: number;
    dispute: { amountMinor: number; status: string } | null;
    disputeRetransferredMinor: number;
    refundedMinor: number;
    refundPendingMinor: number;
    totalMinor: number;
    transferReversedMinor: number;
    withheldMinor: number;
    withholdingReleasedMinor: number;
  };
  orderId: string;
  orderNumber: string;
  paidAt: string;
  paymentIntentId: string;
  payout: Payout;
  production: { printer: string | null; productionCostMinor: number | null; withholdMinor: number | null } | null;
  /** src/commerce/recipient.ts RecipientView; null for an order made before 0045. */
  recipient: RecipientView | null;
  status: string;
  stripeChargeId: string | null;
  stripeTransferId: string | null;
  tenantId: string;
}

interface PlatformOrderRow extends PayoutFacts {
  cancelled_at: string | null;
  connect_account_id: string | null;
  created_at: number;
  currency: string;
  delivery_method: string;
  dispute_amount_minor: number;
  has_snapshot: number;
  is_personalized: number;
  order_id: string;
  order_number: string;
  payment_intent_id: string;
  printer: string | null;
  production_cost_minor: number | null;
  production_withhold_minor: number | null;
  refund_reserved_minor: number;
  status: string;
  stripe_charge_id: string | null;
  stripe_payouts_enabled: number;
  stripe_transfer_id: string | null;
  tenant_id: string;
  total_minor: number;
  withheld_minor: number;
}

interface DispatchRow {
  aggregate_id: string;
  attempts: number;
  last_error: string | null;
  line_no: number | null;
  outbox_id: string;
  result_ref: string | null;
  status: string;
}

async function listPlatformOrders(
  db: D1Database,
  query: OrderListQuery,
  now: number,
): Promise<{ nextCursor: string | null; orders: PlatformOrderView[] }> {
  const where = ["o.tenant_id = ?"];
  const binds: unknown[] = [query.tenantId];
  if (query.since !== null) {
    where.push("o.created_at >= ?");
    binds.push(query.since);
  }
  if (query.cursor !== null) {
    where.push("(o.created_at, o.order_id) > (?, ?)");
    binds.push(query.cursor.createdAt, query.cursor.orderId);
  }
  const rows = await db
    .prepare(
      `SELECT o.order_id, o.order_number, o.tenant_id, o.status, o.created_at,
              o.payment_intent_id, o.stripe_charge_id, o.stripe_transfer_id,
              o.connect_account_id, o.currency, o.delivery_method, o.total_minor,
              o.withheld_minor, o.refund_reserved_minor, o.dispute_amount_minor,
              o.cancelled_at, o.is_personalized, ${PAYOUT_FACT_COLUMNS},
              o.production_snapshot_json IS NOT NULL AS has_snapshot,
              json_extract(o.production_snapshot_json, '$.printer') AS printer,
              json_extract(o.production_snapshot_json, '$.totals.productionCostMinor')
                AS production_cost_minor,
              json_extract(o.production_snapshot_json, '$.totals.withholdMinor')
                AS production_withhold_minor,
              t.stripe_payouts_enabled
       FROM orders AS o
       JOIN tenants AS t ON t.tenant_id = o.tenant_id
       WHERE ${where.join(" AND ")}
       ORDER BY o.created_at, o.order_id
       LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<PlatformOrderRow>();

  const page = rows.results.slice(0, query.limit);
  const dispatch = new Map<string, PlatformOrderView["dispatch"]>();
  for (let start = 0; start < page.length; start += IN_CHUNK) {
    const ids = page.slice(start, start + IN_CHUNK).map((row) => row.order_id);
    const lines = await db
      .prepare(
        `SELECT aggregate_id, outbox_id, status, attempts, last_error, result_ref,
                json_extract(payload_json, '$.lineNo') AS line_no
         FROM outbox_events
         WHERE aggregate_type = 'order'
           AND aggregate_id IN (${ids.map(() => "?").join(", ")})
           AND event_type = 'dispatch'
         ORDER BY aggregate_id, line_no, outbox_id`,
      )
      .bind(...ids)
      .all<DispatchRow>();
    for (const line of lines.results) {
      const list = dispatch.get(line.aggregate_id) ?? [];
      list.push({
        attempts: line.attempts,
        lastError: line.last_error,
        lineNo: typeof line.line_no === "number" ? line.line_no : null,
        outboxId: line.outbox_id,
        printerJobRef: line.result_ref,
        state: line.status,
      });
      dispatch.set(line.aggregate_id, list);
    }
  }

  const recipients = await readOrderRecipients(
    db,
    query.tenantId,
    page.map((row) => row.order_id),
  );

  const last = page.at(-1);
  return {
    nextCursor:
      rows.results.length > query.limit && last !== undefined
        ? `${last.created_at}~${last.order_id}`
        : null,
    orders: page.map((row) => ({
      cancelledAt: row.cancelled_at,
      connectAccountId: row.connect_account_id,
      createdAt: new Date(row.created_at).toISOString(),
      currency: row.currency,
      deliveryMethod: row.delivery_method,
      dispatch: dispatch.get(row.order_id) ?? [],
      isPersonalized: row.is_personalized === 1,
      money: {
        applicationFeeMinor: row.application_fee_minor,
        chargedMinor: row.charged_minor,
        dispute:
          row.dispute_status === null
            ? null
            : { amountMinor: row.dispute_amount_minor, status: row.dispute_status },
        disputeRetransferredMinor: row.dispute_retransferred_minor,
        refundedMinor: row.refund_succeeded_minor,
        refundPendingMinor: row.refund_reserved_minor,
        totalMinor: row.total_minor,
        transferReversedMinor: row.transfer_reversed_minor,
        withheldMinor: row.withheld_minor,
        withholdingReleasedMinor: row.withholding_released_minor ?? 0,
      },
      orderId: row.order_id,
      orderNumber: row.order_number,
      paidAt: new Date(row.paid_at).toISOString(),
      paymentIntentId: row.payment_intent_id,
      payout: computePayout(row, now, row.stripe_payouts_enabled === 1),
      production:
        row.has_snapshot === 1
          ? {
              printer: row.printer,
              productionCostMinor: row.production_cost_minor,
              withholdMinor: row.production_withhold_minor,
            }
          : null,
      recipient: recipients.get(row.order_id) ?? null,
      status: row.status,
      stripeChargeId: row.stripe_charge_id,
      stripeTransferId: row.stripe_transfer_id,
      tenantId: row.tenant_id,
    })),
  };
}

export async function handlePlatformOrdersRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const query = parseOrderListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  return jsonResponse(await listPlatformOrders(env.DB, query, Date.now()));
}

export async function handlePlatformAlertsRoute(
  env: Env,
  request: Request,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || request.method !== "GET") {
    return routeNotFoundResponse();
  }
  const query = parseAlertListQuery(new URL(request.url));
  if (query === null) {
    return invalidRequestResponse();
  }
  return jsonResponse(await listAlerts(env.DB, query));
}

export async function handlePlatformAlertResolveRoute(
  env: Env,
  request: Request,
  rawAlertId: string,
): Promise<Response> {
  const principal = await authorizePlatformRequest(env, request);
  if (principal === null || !isSameOriginRequest(request) || request.method !== "POST") {
    return routeNotFoundResponse();
  }
  const alertId = decodeSegment(rawAlertId);
  if (alertId === null || !isAlertId(alertId)) {
    return routeNotFoundResponse();
  }
  const input = parseResolveAlertInput(await readJsonBody(request));
  if (input === null) {
    return invalidRequestResponse();
  }

  const result = await resolveAlert(env.DB, principal.userId, alertId, input, Date.now());
  switch (result.status) {
    case "ok":
      return jsonResponse({ alert: result.alert });
    case "conflict":
      return jsonResponse(
        { error: { code: "conflict", message: "The alert is already resolved" } },
        409,
      );
    default:
      return routeNotFoundResponse();
  }
}
