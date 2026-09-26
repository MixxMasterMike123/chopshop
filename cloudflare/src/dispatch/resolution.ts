import type { PlatformPrincipal } from "../auth/live-authorization";
import { nudgeOutbox } from "../outbox/nudge";
import { iso, type OutboxRow, readOutboxRow } from "../outbox/outbox";
import { printerCancellationId, printerCancellationInsert } from "./dispatch-effect";

/**
 * Manual resolution of a dispatch whose printer result is unknown (PLAN §2.3:
 * "SnapWear has no status API, so an unknown older than 30 min raises an alert
 * requiring a human check and a manual accepted/failed resolution recorded with
 * who/when"), plus the platform's list of dispatches needing a human.
 *
 *   GET  /v1/platform/dispatch?state=unknown|failed[&cursor=…][&limit=…]
 *   POST /v1/platform/dispatch/:outboxId/resolve
 *        { outcome: "accepted" | "failed", printerJobRef?, note }
 *
 * Resolvable rows: `unknown` (accepted | failed) and `failed` (accepted — the
 * printer did take it after all — or failed, which acknowledges the failure and
 * closes its alerts). The move, the order line, the printer_cancellation a
 * cancelled order now needs, the alert resolution and the audit event
 * (who = the platform user, when = now, why = the note) are ONE batch,
 * conditioned on the row still being in the state the operator saw — a row the
 * automatic re-submit moved meanwhile answers 409 and changes nothing.
 */

export const DISPATCH_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_NOTE_LENGTH = 1_000;
const MAX_REF_LENGTH = 200;

export type DispatchListState = "failed" | "unknown";

export interface DispatchView {
  attempts: number;
  cancelRequested: boolean;
  createdAt: string;
  jobId: string | null;
  lastError: string | null;
  lineNo: number | null;
  maxAttempts: number;
  orderId: string;
  outboxId: string;
  printerJobRef: string | null;
  resolvedAt: string | null;
  state: OutboxRow["status"];
  submittedAt: string | null;
  tenantId: string | null;
  unknownSince: string | null;
  updatedAt: string;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}

function payloadField(row: OutboxRow, field: "jobId" | "lineNo"): unknown {
  try {
    return (JSON.parse(row.payload_json) as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

export function dispatchView(row: OutboxRow): DispatchView {
  const jobId = payloadField(row, "jobId");
  const lineNo = payloadField(row, "lineNo");
  return {
    attempts: row.attempts,
    cancelRequested: row.cancel_requested === 1,
    createdAt: iso(row.created_at),
    jobId: typeof jobId === "string" ? jobId : null,
    lastError: row.last_error,
    lineNo: typeof lineNo === "number" ? lineNo : null,
    maxAttempts: row.max_attempts,
    orderId: row.aggregate_id,
    outboxId: row.outbox_id,
    printerJobRef: row.result_ref,
    resolvedAt: isoOrNull(row.resolved_at),
    state: row.status,
    submittedAt: isoOrNull(row.submitted_at),
    tenantId: row.tenant_id,
    unknownSince: isoOrNull(row.unknown_since),
    updatedAt: iso(row.updated_at),
  };
}

// ── list ────────────────────────────────────────────────────────────────────

export interface DispatchListQuery {
  cursor: { createdAt: number; outboxId: string } | null;
  limit: number;
  state: DispatchListState;
}

const CURSOR_PATTERN = /^(\d{1,16})~([A-Za-z0-9:_-]{1,200})$/;

export function parseDispatchListQuery(url: URL): DispatchListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (key !== "state" && key !== "cursor" && key !== "limit") {
      return null;
    }
  }
  const state = params.get("state");
  if (state !== "unknown" && state !== "failed") {
    return null;
  }
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? DISPATCH_LIST_LIMIT : Number(limitRaw);
  if (!/^\d{1,3}$/.test(limitRaw ?? "50") || limit < 1 || limit > MAX_LIST_LIMIT) {
    return null;
  }
  const cursorRaw = params.get("cursor");
  let cursor: DispatchListQuery["cursor"] = null;
  if (cursorRaw !== null) {
    const match = CURSOR_PATTERN.exec(cursorRaw);
    if (match === null) {
      return null;
    }
    cursor = { createdAt: Number(match[1]), outboxId: match[2] as string };
  }
  return { cursor, limit, state };
}

export async function listDispatches(
  db: D1Database,
  query: DispatchListQuery,
): Promise<{ dispatches: DispatchView[]; nextCursor: string | null }> {
  const after = query.cursor === null ? "" : "AND (created_at, outbox_id) > (?, ?)";
  const rows = await db
    .prepare(
      `SELECT outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
              dedupe_key, payload_json, status, attempts, max_attempts,
              next_attempt_at, last_attempt_at, resolved_at, last_error,
              created_at, updated_at, claimed_by, claim_expires_at,
              cancel_requested, result_ref, submitted_at, unknown_since
       FROM outbox_events
       WHERE event_type = 'dispatch' AND status = ? ${after}
       ORDER BY created_at, outbox_id
       LIMIT ?`,
    )
    .bind(
      query.state,
      ...(query.cursor === null ? [] : [query.cursor.createdAt, query.cursor.outboxId]),
      query.limit + 1,
    )
    .all<OutboxRow>();

  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);
  return {
    dispatches: page.map(dispatchView),
    nextCursor:
      rows.results.length > query.limit && last !== undefined
        ? `${last.created_at}~${last.outbox_id}`
        : null,
  };
}

// ── resolve ─────────────────────────────────────────────────────────────────

export interface ResolveDispatchInput {
  note: string;
  outcome: "accepted" | "failed";
  printerJobRef: string | null;
}

function isCleanText(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseResolveDispatchInput(body: unknown): ResolveDispatchInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["note", "outcome", "printerJobRef"].includes(key))) {
    return null;
  }
  const { note, outcome, printerJobRef } = record;
  if (outcome !== "accepted" && outcome !== "failed") {
    return null;
  }
  if (typeof note !== "string" || !isCleanText(note.trim(), MAX_NOTE_LENGTH)) {
    return null;
  }
  if (printerJobRef !== undefined && printerJobRef !== null) {
    // A printer reference only makes sense for a job the printer has.
    if (
      outcome !== "accepted" ||
      typeof printerJobRef !== "string" ||
      !isCleanText(printerJobRef.trim(), MAX_REF_LENGTH)
    ) {
      return null;
    }
  }
  return {
    note: note.trim(),
    outcome,
    printerJobRef: typeof printerJobRef === "string" ? printerJobRef.trim() : null,
  };
}

export type ResolveDispatchResult =
  | { dispatch: DispatchView; status: "ok" }
  | { status: "conflict" }
  | { status: "not_found" };

export async function resolveDispatch(
  env: Env,
  principal: PlatformPrincipal,
  outboxId: string,
  input: ResolveDispatchInput,
  nowMs: number,
): Promise<ResolveDispatchResult> {
  const db = env.DB;
  const row = await readOutboxRow(db, outboxId);
  if (row === null || row.event_type !== "dispatch") {
    return { status: "not_found" };
  }
  if (row.status !== "unknown" && row.status !== "failed") {
    return { status: "conflict" };
  }

  const from = row.status;
  const acknowledgeOnly = from === "failed" && input.outcome === "failed";
  // The row as the operator saw it: state, cancellation flag and last change.
  const stillAsSeen = {
    binds: [outboxId, from, row.cancel_requested, row.updated_at],
    sql: `EXISTS (SELECT 1 FROM outbox_events AS s
                  WHERE s.outbox_id = ? AND s.status = ? AND s.cancel_requested = ?
                    AND s.updated_at = ?)`,
  };
  const lineNo = payloadField(row, "lineNo");
  const jobId = payloadField(row, "jobId");
  const metadata = JSON.stringify({
    from,
    jobId: typeof jobId === "string" ? jobId : null,
    lastError: row.last_error,
    lineNo: typeof lineNo === "number" ? lineNo : null,
    orderId: row.aggregate_id,
    outcome: input.outcome,
    printerJobRef: input.printerJobRef,
  });

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type, resource_id,
           reason, request_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, 'dispatch.resolve', 'outbox_event', ?, ?, ?, ?, ?
         WHERE ${stillAsSeen.sql}`,
      )
      .bind(
        crypto.randomUUID(),
        row.tenant_id,
        principal.userId,
        outboxId,
        input.note,
        crypto.randomUUID(),
        metadata,
        nowMs,
        ...stillAsSeen.binds,
      ),
    db
      .prepare(
        // MAX: an alert stamped by a clock slightly ahead of this one must
        // still satisfy resolved_at >= created_at (ISO strings order by time).
        `UPDATE alerts SET resolved_at = MAX(created_at, ?)
         WHERE resource_type = 'outbox_event' AND resource_id = ? AND resolved_at IS NULL
           AND ${stillAsSeen.sql}`,
      )
      .bind(iso(nowMs), outboxId, ...stillAsSeen.binds),
  ];

  if (!acknowledgeOnly && typeof lineNo === "number" && row.tenant_id !== null) {
    statements.push(
      input.outcome === "accepted"
        ? db
            .prepare(
              `UPDATE order_items
               SET dispatch_state = 'accepted',
                   printer_job_ref = COALESCE(printer_job_ref, ?),
                   dispatched_at = COALESCE(dispatched_at, ?)
               WHERE order_id = ? AND tenant_id = ? AND item_index = ?
                 AND ${stillAsSeen.sql}`,
            )
            .bind(
              input.printerJobRef,
              iso(nowMs),
              row.aggregate_id,
              row.tenant_id,
              lineNo - 1,
              ...stillAsSeen.binds,
            )
        : db
            .prepare(
              `UPDATE order_items
               SET dispatch_state = CASE WHEN ? = 1 THEN 'cancelled' ELSE 'failed' END
               WHERE order_id = ? AND tenant_id = ? AND item_index = ?
                 AND ${stillAsSeen.sql}`,
            )
            .bind(
              row.cancel_requested,
              row.aggregate_id,
              row.tenant_id,
              lineNo - 1,
              ...stillAsSeen.binds,
            ),
    );
  }

  if (input.outcome === "accepted") {
    // A cancelled order whose job the printer turns out to have (§2.3 path 3).
    statements.push(
      printerCancellationInsert(db, {
        nowMs,
        printerJobRef: input.printerJobRef,
        where: {
          binds: [outboxId, ...stillAsSeen.binds],
          sql: `d.outbox_id = ? AND d.cancel_requested = 1 AND ${stillAsSeen.sql}`,
        },
      }),
    );
  }

  const move = acknowledgeOnly
    ? db
        .prepare(
          // A human decided: marked `resolved_failed` (the original code is in
          // the audit), so the reconciliation net can tell it from a live failure.
          `UPDATE outbox_events
           SET last_error = 'resolved_failed', updated_at = MAX(updated_at, ?)
           WHERE outbox_id = ? AND status = ? AND cancel_requested = ? AND updated_at = ?
           RETURNING outbox_id`,
        )
        .bind(nowMs, outboxId, from, row.cancel_requested, row.updated_at)
    : db
        .prepare(
          `UPDATE outbox_events
           SET status = ?, result_ref = COALESCE(result_ref, ?), resolved_at = ?,
               last_error = ?, updated_at = MAX(updated_at, ?)
           WHERE outbox_id = ? AND status = ? AND cancel_requested = ? AND updated_at = ?
           RETURNING outbox_id`,
        )
        .bind(
          input.outcome === "accepted" ? "done" : "failed",
          input.outcome === "accepted" ? input.printerJobRef : null,
          nowMs,
          input.outcome === "accepted" ? null : "resolved_failed",
          nowMs,
          outboxId,
          from,
          row.cancel_requested,
          row.updated_at,
        );
  statements.push(move);

  const results = await db.batch(statements);
  if ((results.at(-1)?.results.length ?? 0) === 0) {
    return { status: "conflict" };
  }

  const resolved = await readOutboxRow(db, outboxId);
  if (resolved === null) {
    return { status: "not_found" };
  }
  if (input.outcome === "accepted" && resolved.cancel_requested === 1) {
    await nudgeOutbox(env, [printerCancellationId(outboxId)]);
  }
  return { dispatch: dispatchView(resolved), status: "ok" };
}
