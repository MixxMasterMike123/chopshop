/**
 * `nudgeOutbox(env, outboxIds)` — tell the `-outbox` consumer that rows exist.
 *
 * A nudge is `{ outboxId }` and nothing else: the ROW is the truth, so a nudge
 * for a row that is already done is simply acked, and a lost nudge loses
 * nothing — the 15-minute sweeper (src/outbox/sweeper.ts) claims every due row
 * whether or not anyone nudged it.
 *
 * Call it AFTER the batch that inserted the rows has committed (a nudge for a
 * row that does not exist yet is acked and wasted). It never throws: a queue
 * failure is logged and the sweeper is the backstop, so a caller's own success
 * — an order written, a cancellation recorded — never depends on the queue.
 *
 * CP2-A's webhook inserts `outbox(dispatch)` + `outbox(email)` in the order
 * batch; calling this with those ids right after the batch makes dispatch
 * prompt instead of "within 15 minutes".
 */

/** Queues accept at most 100 messages per sendBatch. */
const SEND_BATCH_LIMIT = 100;

const OUTBOX_ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;

export function isOutboxId(value: unknown): value is string {
  return typeof value === "string" && OUTBOX_ID_PATTERN.test(value);
}

export async function nudgeOutbox(
  env: Env,
  outboxIds: readonly string[],
  options: { delaySeconds?: number } = {},
): Promise<void> {
  const queue = env.OUTBOX_QUEUE;
  const ids = [...new Set(outboxIds)].filter(isOutboxId);
  if (queue === undefined || ids.length === 0) {
    return;
  }

  for (let start = 0; start < ids.length; start += SEND_BATCH_LIMIT) {
    const chunk = ids.slice(start, start + SEND_BATCH_LIMIT);
    try {
      await queue.sendBatch(
        chunk.map((outboxId) => ({
          body: { outboxId },
          contentType: "json" as const,
          ...(options.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }),
        })),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          error: error instanceof Error ? error.name : "unknown",
          message: "outbox nudge could not be enqueued; the sweeper will claim the rows",
          nudges: chunk.length,
        }),
      );
    }
  }
}

/**
 * The pending mail rows of one order (the buyer's status mail, the refund
 * notice, …), for a nudge right after the batch that wrote them — else they
 * wait for the next sweep. This shop's rows only; bounded.
 */
export async function pendingOrderMailIds(
  db: D1Database,
  tenantId: string,
  orderId: string,
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT outbox_id FROM outbox_events
       WHERE aggregate_type = 'order' AND aggregate_id = ? AND tenant_id = ?
         AND event_type IN ('email', 'email.order_status') AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 10`,
    )
    .bind(orderId, tenantId)
    .all<{ outbox_id: string }>();
  return rows.results.map((row) => row.outbox_id);
}
