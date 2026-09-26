import { nudgeRenderJob } from "../pod/render-jobs";
import { processNextOutboxRow } from "./effects";
import { nudgeOutbox } from "./nudge";
import { iso, OUTBOX_EFFECT_TYPES } from "./outbox";

/**
 * The 15-minute sweeper (PLAN §2.2) — the backstop that makes a lost queue
 * message, a dead worker or a queue outage cost at most one sweep interval.
 *
 * One run, in order:
 *   1. SETTLE EXHAUSTED CLAIMS. A claimed/submitting row whose claim expired on
 *      its last allowed attempt can never be claimed again (claims stop at
 *      max_attempts). If its call never went out it is `failed`; if it may have
 *      (`submitted_at`) it is `unknown` — never silently failed, because the
 *      receiver may have acted. Both alert.
 *   2. DRAIN inline: claim and run up to SWEEP_INLINE_LIMIT due rows (pending
 *      and due, unknown and due, or an expired claim). This is what keeps work
 *      moving when the queue itself is down.
 *   3. NUDGE the rest that are due, through the queue, so a backlog is worked in
 *      parallel rather than ten per sweep.
 *   4. ALERT on dispatches whose printer result has been unknown for 30 minutes
 *      (`dispatch_unknown_30m`): SnapWear has no status API, so a human checks
 *      the printer and resolves (POST /v1/platform/dispatch/:id/resolve).
 *   5. RE-NUDGE THE RENDER CONTAINER when a render job has waited in `queued`
 *      longer than RENDER_STALE_MS or holds an expired lease (CP1-D open
 *      question 4): one nudge wakes the container, which drains everything.
 */

export const SWEEP_INLINE_LIMIT = 10;
export const SWEEP_NUDGE_LIMIT = 500;
export const UNKNOWN_ALERT_AFTER_MS = 30 * 60 * 1_000;
export const RENDER_STALE_MS = 5 * 60 * 1_000;

export interface OutboxSweepSummary {
  processed: number;
  nudged: number;
  renderNudged: boolean;
  settled: number;
  unknownAlerts: number;
}

const KNOWN_TYPES_SQL = OUTBOX_EFFECT_TYPES.map((type) => `'${type}'`).join(", ");

async function settleExhaustedClaims(db: D1Database, now: number): Promise<number> {
  const exhausted = `status IN ('claimed', 'submitting')
      AND claim_expires_at < ?
      AND attempts >= max_attempts
      AND event_type IN (${KNOWN_TYPES_SQL})`;
  const nowIso = iso(now);
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO alerts (
           id, tenant_id, kind, severity, message, resource_type, resource_id, created_at
         )
         SELECT 'outbox-exhausted:' || outbox_id, tenant_id, 'outbox_exhausted', 'critical',
                'Outbox ' || event_type || ' ' || outbox_id || ' for ' || aggregate_type || ' '
                  || aggregate_id || ' ran out of attempts while in flight'
                  || CASE WHEN submitted_at IS NULL
                       THEN '; it never reached the receiver.'
                       ELSE '; it may have reached the receiver: check and resolve it.' END,
                'outbox_event', outbox_id, ?
         FROM outbox_events WHERE ${exhausted}
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(nowIso, now),
    db
      .prepare(
        `UPDATE order_items
         SET dispatch_state = CASE WHEN x.submitted_at IS NULL THEN 'failed' ELSE 'unknown' END
         FROM (
           SELECT tenant_id, aggregate_id, submitted_at,
                  json_extract(payload_json, '$.lineNo') AS line_no
           FROM outbox_events
           WHERE ${exhausted} AND event_type = 'dispatch'
         ) AS x
         WHERE order_items.order_id = x.aggregate_id
           AND order_items.tenant_id = x.tenant_id
           AND order_items.item_index = x.line_no - 1`,
      )
      .bind(now),
    db
      .prepare(
        `UPDATE outbox_events
         SET status = CASE WHEN submitted_at IS NULL THEN 'failed' ELSE 'unknown' END,
             resolved_at = CASE WHEN submitted_at IS NULL THEN ? ELSE NULL END,
             unknown_since = CASE WHEN submitted_at IS NULL THEN unknown_since
                                  ELSE COALESCE(unknown_since, ?) END,
             last_error = 'attempts_exhausted',
             claimed_by = NULL, claim_expires_at = NULL,
             updated_at = MAX(updated_at, ?)
         WHERE ${exhausted}`,
      )
      .bind(now, now, now, now),
  ]);
  return results.at(-1)?.meta.changes ?? 0;
}

async function alertLongUnknownDispatches(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO alerts (
         id, tenant_id, kind, severity, message, resource_type, resource_id, created_at
       )
       SELECT 'dispatch-unknown-30m:' || outbox_id, tenant_id, 'dispatch_unknown_30m', 'critical',
              'Dispatch ' || outbox_id || ' (printer job '
                || COALESCE(json_extract(payload_json, '$.jobId'), '?')
                || ') has had no printer answer for over 30 minutes. The printer has no status API: check its dashboard, then resolve the dispatch as accepted or failed.',
              'outbox_event', outbox_id, ?
       FROM outbox_events
       WHERE event_type = 'dispatch'
         AND status IN ('unknown', 'claimed', 'submitting')
         AND unknown_since IS NOT NULL
         AND unknown_since <= ?
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(iso(now), now - UNKNOWN_ALERT_AFTER_MS)
    .run();
  return result.meta.changes;
}

async function dueOutboxIds(db: D1Database, now: number): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT outbox_id FROM outbox_events
       WHERE event_type IN (${KNOWN_TYPES_SQL})
         AND attempts < max_attempts
         AND (
           (status = 'pending' AND next_attempt_at <= ?)
           OR (status = 'unknown' AND cancel_requested = 0 AND next_attempt_at <= ?)
           OR (status IN ('claimed', 'submitting') AND claim_expires_at < ?)
         )
       ORDER BY next_attempt_at, created_at, outbox_id
       LIMIT ${SWEEP_NUDGE_LIMIT}`,
    )
    .bind(now, now, now)
    .all<{ outbox_id: string }>();
  return rows.results.map((row) => row.outbox_id);
}

async function renudgeStaleRenderJob(env: Env, now: number): Promise<boolean> {
  const stale = await env.DB.prepare(
    `SELECT id FROM render_jobs
     WHERE (state = 'queued' AND updated_at <= ?)
        OR (state = 'leased' AND lease_until < ?)
     ORDER BY created_at, id
     LIMIT 1`,
  )
    .bind(iso(now - RENDER_STALE_MS), iso(now))
    .first<{ id: string }>();
  if (stale === null) {
    return false;
  }
  await nudgeRenderJob(env, stale.id);
  return true;
}

export async function runOutboxSweep(env: Env, now: number): Promise<OutboxSweepSummary> {
  // Effects see time advance from `now` as the sweep runs.
  const offset = now - Date.now();
  const clock = () => Date.now() + offset;

  const settled = await settleExhaustedClaims(env.DB, clock());

  let processed = 0;
  while (processed < SWEEP_INLINE_LIMIT) {
    let ran: Awaited<ReturnType<typeof processNextOutboxRow>>;
    try {
      ran = await processNextOutboxRow(env, clock);
    } catch (error) {
      // The claimed row stays claimed until its claim expires; keep sweeping.
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.name : "unknown",
          message: "outbox sweep: an effect failed unexpectedly",
        }),
      );
      processed += 1;
      continue;
    }
    if (ran === null) {
      break;
    }
    processed += 1;
  }

  const due = await dueOutboxIds(env.DB, clock());
  await nudgeOutbox(env, due);

  const unknownAlerts = await alertLongUnknownDispatches(env.DB, clock());
  const renderNudged = await renudgeStaleRenderJob(env, clock());

  const summary = { nudged: due.length, processed, renderNudged, settled, unknownAlerts };
  console.log(JSON.stringify({ message: "outbox sweep", ...summary }));
  return summary;
}
