import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import { nudgeOutbox } from "../outbox/nudge";
import { iso, type OutboxStatus } from "../outbox/outbox";
import { printerCancellationId, printerCancellationInsert } from "./dispatch-effect";

/**
 * Cancellation vs dispatch (PLAN §2.3) — the four paths, per order line:
 *
 *   1. BEFORE CLAIM (dispatch row `pending`, the call never went out)
 *        → `superseded` in the cancellation's own batch; line `cancelled`.
 *          Zero printer jobs, by construction.
 *   2. WHILE CLAIMED / SUBMITTING
 *        → `cancel_requested = 1`. The dispatcher re-checks it after claiming
 *          and atomically at claimed → submitting (so it stops before the HTTP
 *          call). If the call was already out and comes back accepted (or
 *          duplicate), the completing batch inserts a `printer_cancellation`
 *          outbox row; rejected → superseded; lost → unknown + alert.
 *   3. AFTER ACCEPTANCE (dispatch row `done`)
 *        → a `printer_cancellation` outbox row now. SnapWear has no
 *          cancellation API, so its effect is the human-action alert
 *          `printer_cancellation_needed`.
 *   4. AFTER PRODUCTION (`order_items.production_state` produced/shipped, or
 *      the order already printed/shipped/handed over)
 *        → refused as a RETURN CASE (409 `return_case`); nothing changes.
 *
 * Also: an `unknown` row (answer lost) gets `cancel_requested = 1`, which stops
 * its automatic re-submission, and an immediate `dispatch_cancel_unconfirmed`
 * alert — a human checks the printer and resolves it (accepted →
 * printer_cancellation; failed → nothing to undo). A `failed` row (the printer
 * never took it) is flagged too, so a later manual "accepted" still produces
 * the printer cancellation.
 *
 * CANCELLING MOVES NO MONEY. A refund is CP2-A's separate call; this records the
 * cancellation (orders.cancelled_at/cancel_reason + an audit event) and settles
 * the dispatch side only. It does not move `orders.status` either — whose
 * refund transitions belong to CP2-A.
 *
 * Every statement is conditioned on the CURRENT state, so the set is safe to
 * run in any batch and idempotent: a repeated cancellation changes nothing.
 * `dispatchCancellationStatements` is exported for exactly that reason — a full
 * refund that must stop production can put them in its own batch.
 */

export const RETURN_CASE_ORDER_STATUSES = [
  "printed",
  "shipped",
  "ready_for_pickup",
  "delivered",
  "completed",
] as const;

export type CancelOutcome =
  | "awaiting_resolution"
  | "cancel_requested"
  | "cancelled"
  | "not_at_printer"
  | "printer_cancellation";

export interface CancelledLine {
  jobId: string;
  lineNo: number;
  outcome: CancelOutcome;
}

export interface OrderCancellation {
  cancelledAt: string;
  lines: CancelledLine[];
  orderId: string;
  reason: string;
}

export type CancelOrderResult =
  | { cancellation: OrderCancellation; status: "ok" }
  | { status: "not_found" }
  | { status: "return_case" };

const MAX_REASON_LENGTH = 500;

export function parseCancelOrderInput(body: unknown): { reason: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "reason") || typeof record.reason !== "string") {
    return null;
  }
  const reason = record.reason.trim();
  return reason.length === 0 ||
    reason.length > MAX_REASON_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(reason)
    ? null
    : { reason };
}

/** No line is physically made, and the order is not past production. */
function notProducedSql(): string {
  return `NOT EXISTS (
      SELECT 1 FROM order_items AS p
      WHERE p.order_id = ? AND p.tenant_id = ?
        AND p.production_state IN ('produced', 'shipped')
    )
    AND NOT EXISTS (
      SELECT 1 FROM orders AS q
      WHERE q.order_id = ? AND q.tenant_id = ?
        AND q.status IN (${RETURN_CASE_ORDER_STATUSES.map((status) => `'${status}'`).join(", ")})
    )`;
}

function notProducedBinds(orderId: string, tenantId: string): unknown[] {
  return [orderId, tenantId, orderId, tenantId];
}

/**
 * The dispatch half of a cancellation, as state-conditional statements.
 * Order matters: the line update reads the rows the supersede then moves.
 */
export function dispatchCancellationStatements(
  db: D1Database,
  input: { nowMs: number; orderId: string; tenantId: string },
): D1PreparedStatement[] {
  const { nowMs, orderId, tenantId } = input;
  const guard = notProducedSql();
  const guardBinds = notProducedBinds(orderId, tenantId);
  const dispatchRows = `event_type = 'dispatch' AND aggregate_id = ? AND tenant_id = ?`;

  return [
    // Lines that will never reach the printer: not yet sent (path 1), or
    // refused by it.
    db
      .prepare(
        `UPDATE order_items SET dispatch_state = 'cancelled'
         WHERE order_id = ? AND tenant_id = ?
           AND item_index + 1 IN (
             SELECT json_extract(payload_json, '$.lineNo') FROM outbox_events
             WHERE ${dispatchRows}
               AND ((status = 'pending' AND submitted_at IS NULL) OR status = 'failed')
           )
           AND ${guard}`,
      )
      .bind(orderId, tenantId, orderId, tenantId, ...guardBinds),
    // Path 1: before claim → superseded, in this batch.
    db
      .prepare(
        `UPDATE outbox_events
         SET status = 'superseded', cancel_requested = 1, resolved_at = ?,
             last_error = 'cancelled', updated_at = MAX(updated_at, ?)
         WHERE ${dispatchRows} AND status = 'pending' AND submitted_at IS NULL
           AND ${guard}`,
      )
      .bind(nowMs, nowMs, orderId, tenantId, ...guardBinds),
    // Path 2 (+ unknown, failed, and a pending row a previous attempt may
    // have sent): flag it; the dispatcher and the resolution honour the flag.
    db
      .prepare(
        `UPDATE outbox_events
         SET cancel_requested = 1, updated_at = MAX(updated_at, ?)
         WHERE ${dispatchRows}
           AND status IN ('pending', 'claimed', 'submitting', 'unknown', 'failed')
           AND cancel_requested = 0
           AND ${guard}`,
      )
      .bind(nowMs, orderId, tenantId, ...guardBinds),
    // An unknown row now waits for a human, who is told at once.
    db
      .prepare(
        `INSERT INTO alerts (
           id, tenant_id, kind, severity, message, resource_type, resource_id, created_at
         )
         SELECT 'dispatch-cancel-unconfirmed:' || outbox_id, tenant_id,
                'dispatch_cancel_unconfirmed', 'critical',
                'Order ' || aggregate_id || ' was cancelled while dispatch ' || outbox_id
                  || ' (printer job ' || COALESCE(json_extract(payload_json, '$.jobId'), '?')
                  || ') had no printer answer. Check the printer and resolve the dispatch.',
                'outbox_event', outbox_id, ?
         FROM outbox_events
         WHERE ${dispatchRows} AND status = 'unknown' AND cancel_requested = 1
           AND ${guard}
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(iso(nowMs), orderId, tenantId, ...guardBinds),
    // Path 3: after acceptance → printer_cancellation.
    printerCancellationInsert(db, {
      nowMs,
      printerJobRef: null,
      where: {
        binds: [orderId, tenantId, ...guardBinds],
        sql: `d.aggregate_id = ? AND d.tenant_id = ? AND d.status = 'done' AND ${guard}`,
      },
    }),
  ];
}

interface DispatchRowState {
  cancel_requested: number;
  job_id: string | null;
  line_no: number | null;
  outbox_id: string;
  status: OutboxStatus;
}

function outcomeFor(row: DispatchRowState): CancelOutcome {
  switch (row.status) {
    case "superseded":
      return "cancelled";
    case "done":
      return "printer_cancellation";
    case "unknown":
      return "awaiting_resolution";
    case "failed":
      return "not_at_printer";
    default:
      return "cancel_requested";
  }
}

async function readDispatchRows(
  db: D1Database,
  orderId: string,
  tenantId: string,
): Promise<DispatchRowState[]> {
  const rows = await db
    .prepare(
      `SELECT outbox_id, status, cancel_requested,
              json_extract(payload_json, '$.lineNo') AS line_no,
              json_extract(payload_json, '$.jobId') AS job_id
       FROM outbox_events
       WHERE event_type = 'dispatch' AND aggregate_id = ? AND tenant_id = ?
       ORDER BY line_no
       LIMIT 200`,
    )
    .bind(orderId, tenantId)
    .all<DispatchRowState>();
  return rows.results;
}

/** POST /v1/admin/orders/:orderId/cancel. */
export async function cancelOrder(
  env: Env,
  principal: TenantAdminPrincipal,
  input: { orderId: string; reason: string },
  nowMs: number,
): Promise<CancelOrderResult> {
  const db = env.DB;
  const { orderId } = input;
  const tenantId = principal.tenantId;

  const order = await db
    .prepare(`SELECT order_id FROM orders WHERE order_id = ? AND tenant_id = ? LIMIT 1`)
    .bind(orderId, tenantId)
    .first<{ order_id: string }>();
  if (order === null) {
    return { status: "not_found" };
  }

  const guard = notProducedSql();
  const guardBinds = notProducedBinds(orderId, tenantId);
  const firstCancellation = `EXISTS (
      SELECT 1 FROM orders AS c
      WHERE c.order_id = ? AND c.tenant_id = ? AND c.cancelled_at IS NULL
    )`;

  await db.batch([
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type, resource_id,
           reason, request_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, 'order.cancel', 'order', ?, ?, ?, ?, ?
         WHERE ${firstCancellation} AND ${guard}`,
      )
      .bind(
        crypto.randomUUID(),
        tenantId,
        principal.userId,
        orderId,
        input.reason,
        crypto.randomUUID(),
        auditMetadataJson(principal, { moneyMoved: false }),
        nowMs,
        orderId,
        tenantId,
        ...guardBinds,
      ),
    ...dispatchCancellationStatements(db, { nowMs, orderId, tenantId }),
    db
      .prepare(
        `UPDATE orders
         SET cancelled_at = ?, cancel_reason = ?, updated_at = MAX(updated_at, ?)
         WHERE order_id = ? AND tenant_id = ? AND cancelled_at IS NULL AND ${guard}`,
      )
      .bind(iso(nowMs), input.reason, nowMs, orderId, tenantId, ...guardBinds),
  ]);

  const recorded = await db
    .prepare(
      `SELECT cancelled_at, cancel_reason FROM orders
       WHERE order_id = ? AND tenant_id = ? LIMIT 1`,
    )
    .bind(orderId, tenantId)
    .first<{ cancel_reason: string | null; cancelled_at: string | null }>();
  if (recorded?.cancelled_at === null || recorded?.cancelled_at === undefined) {
    // Every statement was guarded on "not produced": nothing was written.
    return { status: "return_case" };
  }

  const rows = await readDispatchRows(db, orderId, tenantId);
  await nudgeOutbox(
    env,
    rows.filter((row) => row.status === "done").map((row) => printerCancellationId(row.outbox_id)),
  );

  return {
    cancellation: {
      cancelledAt: recorded.cancelled_at,
      lines: rows.map((row) => ({
        jobId: row.job_id ?? "",
        lineNo: row.line_no ?? 0,
        outcome: outcomeFor(row),
      })),
      orderId,
      reason: recorded.cancel_reason ?? input.reason,
    },
    status: "ok",
  };
}
