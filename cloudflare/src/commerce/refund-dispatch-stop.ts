import { RETURN_CASE_ORDER_STATUSES } from "../dispatch/cancellation";
import { printerCancellationInsert } from "../dispatch/dispatch-effect";

/**
 * "A full refund stops production" — decided INSIDE the settlement batch.
 *
 * ── WHY THIS EXISTS (Codex CP2-A P1) ────────────────────────────────────────
 * The first version read `refund_succeeded_minor` before the batch and added
 * CP2-B's `dispatchCancellationStatements` only when THIS refund would complete
 * the charge. Two concurrent partial refunds that together cover it each read
 * the old total, neither added the statements, and the order ended fully
 * refunded with its dispatch still pending — it would have been printed.
 *
 * Here the condition is SQL evaluated after the batch's own money UPDATE:
 *   this batch performed a transition INTO 'succeeded'   (transition id fence)
 *   AND the order is now refunded to the charge          (read in-batch)
 * D1 runs a batch as one transaction on a single-threaded database, so of two
 * settlements the second to commit sees the first's money and stops dispatch;
 * whichever settlement completes the full refund is the one that cancels.
 *
 * ── WHY IT MIRRORS CP2-B's STATEMENTS ───────────────────────────────────────
 * `dispatchCancellationStatements` (src/dispatch/cancellation.ts, CP2-B's file,
 * not edited here) takes no guard, and a prepared statement cannot be wrapped
 * after the fact. The five statements below are its statements with ONE
 * addition — `AND <guard>` — in the same order, with the same state
 * conditions, the same return-case guard (RETURN_CASE_ORDER_STATUSES is
 * imported, not copied) and CP2-B's own `printerCancellationInsert`, which
 * does accept a guard. test/refund-dispatch-stop.test.ts runs both sets on
 * identical orders in every dispatch state and requires identical results, so
 * a change on CP2-B's side that is not mirrored here fails that parity suite.
 */

export interface SqlGuard {
  binds: unknown[];
  sql: string;
}

/** CP2-B's notProducedSql: no line physically made, order not past production. */
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

/**
 * CP2-B's dispatch cancellation, every statement additionally conditioned on
 * `guard`. With a guard that always holds it is exactly theirs (the parity
 * suite pins that).
 */
export function guardedDispatchCancellationStatements(
  db: D1Database,
  input: { nowMs: number; orderId: string; tenantId: string },
  guard: SqlGuard,
): D1PreparedStatement[] {
  const { nowMs, orderId, tenantId } = input;
  const produced = notProducedSql();
  const producedBinds = [orderId, tenantId, orderId, tenantId];
  const dispatchRows = `event_type = 'dispatch' AND aggregate_id = ? AND tenant_id = ?`;
  const both = `${produced} AND (${guard.sql})`;
  const bothBinds = [...producedBinds, ...guard.binds];

  return [
    db
      .prepare(
        `UPDATE order_items SET dispatch_state = 'cancelled'
         WHERE order_id = ? AND tenant_id = ?
           AND item_index + 1 IN (
             SELECT json_extract(payload_json, '$.lineNo') FROM outbox_events
             WHERE ${dispatchRows}
               AND ((status = 'pending' AND submitted_at IS NULL) OR status = 'failed')
           )
           AND ${both}`,
      )
      .bind(orderId, tenantId, orderId, tenantId, ...bothBinds),
    db
      .prepare(
        `UPDATE outbox_events
         SET status = 'superseded', cancel_requested = 1, resolved_at = ?,
             last_error = 'cancelled', updated_at = MAX(updated_at, ?)
         WHERE ${dispatchRows} AND status = 'pending' AND submitted_at IS NULL
           AND ${both}`,
      )
      .bind(nowMs, nowMs, orderId, tenantId, ...bothBinds),
    db
      .prepare(
        `UPDATE outbox_events
         SET cancel_requested = 1, updated_at = MAX(updated_at, ?)
         WHERE ${dispatchRows}
           AND status IN ('pending', 'claimed', 'submitting', 'unknown', 'failed')
           AND cancel_requested = 0
           AND ${both}`,
      )
      .bind(nowMs, orderId, tenantId, ...bothBinds),
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
           AND ${both}
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(new Date(nowMs).toISOString(), orderId, tenantId, ...bothBinds),
    printerCancellationInsert(db, {
      nowMs,
      printerJobRef: null,
      where: {
        binds: [orderId, tenantId, ...bothBinds],
        sql: `d.aggregate_id = ? AND d.tenant_id = ? AND d.status = 'done' AND ${both}`,
      },
    }),
  ];
}

/**
 * The statements a settlement batch carries: they act only if THIS batch moved
 * `operationId` into 'succeeded' (its transition id) and the order's money,
 * as updated earlier in the same batch, now covers the whole charge.
 */
export function fullRefundStopStatements(
  db: D1Database,
  input: {
    nowMs: number;
    operationId: string;
    orderId: string;
    tenantId: string;
    transitionId: string;
  },
): D1PreparedStatement[] {
  return guardedDispatchCancellationStatements(
    db,
    { nowMs: input.nowMs, orderId: input.orderId, tenantId: input.tenantId },
    {
      binds: [input.operationId, input.transitionId, input.orderId, input.tenantId],
      sql: `EXISTS (
          SELECT 1 FROM refund_operations
          WHERE id = ? AND transition_id = ? AND state = 'succeeded'
        )
        AND EXISTS (
          SELECT 1 FROM orders
          WHERE order_id = ? AND tenant_id = ?
            AND charged_minor > 0
            AND refund_succeeded_minor >= charged_minor
        )`,
    },
  );
}
