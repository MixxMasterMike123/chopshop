/**
 * `alerts` rows (0017) raised by the money paths: work a human must look at.
 *
 * One OPEN alert per (kind, resource). The insert is a single
 * `INSERT … SELECT … WHERE NOT EXISTS (open alert for the same kind and
 * resource)`, which SQLite evaluates atomically, so a reconciliation run that
 * sees the same stranded operation every 15 minutes writes one row, not one
 * per run — and once an operator resolves it, a condition that is STILL true
 * raises a fresh one. The id is random for that reason: a deterministic id
 * would make a resolved alert block every future one for the same resource.
 *
 * Messages carry ids and codes only — never amounts, URLs, tokens or personal
 * data (the column's own rule).
 */

export type MoneyAlertKind =
  | "connect_account_resync_failed"
  | "dispute_recovery_failed"
  | "dispatch_stranded_30m"
  | "order_missing_for_succeeded_pi"
  | "payment_event_deferred_30m"
  | "payout_blocked_dispute"
  | "production_snapshot_invalid"
  | "refund_failed_after_success"
  | "refund_unsettled_30m"
  // D36 (CP2-D2): the application-fee refund of a production withholding.
  | "withholding_release_failed"
  | "withholding_release_unmatched"
  | "withholding_release_unsettled_30m";

export interface MoneyAlert {
  kind: MoneyAlertKind;
  message: string;
  resourceId: string;
  resourceType: string;
  severity: "critical" | "info" | "warning";
  tenantId: string | null;
}

export function raiseAlertStatement(
  db: D1Database,
  alert: MoneyAlert,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO alerts (
        id, tenant_id, kind, severity, message, resource_type, resource_id,
        created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM alerts
        WHERE kind = ?
          AND resource_type = ?
          AND resource_id = ?
          AND resolved_at IS NULL
      )`,
    )
    .bind(
      `${alert.kind}:${crypto.randomUUID()}`,
      alert.tenantId,
      alert.kind,
      alert.severity,
      alert.message,
      alert.resourceType,
      alert.resourceId,
      new Date(now).toISOString(),
      alert.kind,
      alert.resourceType,
      alert.resourceId,
    );
}

/** Raises one alert on its own; returns whether a new row was written. */
export async function raiseAlert(
  db: D1Database,
  alert: MoneyAlert,
  now: number,
): Promise<boolean> {
  const result = await raiseAlertStatement(db, alert, now).run();
  return result.meta.changes === 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// The platform's alert list + manual resolution (CP2-E)
//
//   GET  /v1/platform/alerts?state=open|resolved[&kind][&tenantId][&cursor][&limit]
//   POST /v1/platform/alerts/:alertId/resolve   { note }
//
// Every alert kind, not only the money ones: the table is shared (0017) and an
// operator reads one list. Resolution is final (alerts_resolution_final) and
// audited (who = the platform user, why = the note); a condition that is still
// true simply raises a fresh alert on the next run.
// ═══════════════════════════════════════════════════════════════════════════

export const ALERT_LIST_LIMIT = 50;
const MAX_ALERT_LIST_LIMIT = 100;
const MAX_NOTE_LENGTH = 1_000;
const ALERT_ID_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;
const KIND_PATTERN = /^[a-z0-9_.]{1,64}$/;
const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ALERT_CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([A-Za-z0-9:_.-]{1,200})$/;

export interface AlertView {
  alertId: string;
  createdAt: string;
  kind: string;
  message: string;
  resolution: { at: string; byUserId: string | null; note: string | null } | null;
  resourceId: string | null;
  resourceType: string | null;
  severity: string;
  tenantId: string | null;
}

export interface AlertListQuery {
  cursor: { createdAt: string; id: string } | null;
  kind: string | null;
  limit: number;
  state: "open" | "resolved";
  tenantId: string | null;
}

export function isAlertId(value: unknown): value is string {
  return typeof value === "string" && ALERT_ID_PATTERN.test(value);
}

export function parseAlertListQuery(url: URL): AlertListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!["cursor", "kind", "limit", "state", "tenantId"].includes(key)) {
      return null;
    }
  }
  const state = params.get("state") ?? "open";
  if (state !== "open" && state !== "resolved") {
    return null;
  }
  const kind = params.get("kind");
  if (kind !== null && !KIND_PATTERN.test(kind)) {
    return null;
  }
  const tenantId = params.get("tenantId");
  if (tenantId !== null && !TENANT_PATTERN.test(tenantId)) {
    return null;
  }
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? ALERT_LIST_LIMIT : Number(limitRaw);
  if (!/^\d{1,3}$/.test(limitRaw ?? "50") || limit < 1 || limit > MAX_ALERT_LIST_LIMIT) {
    return null;
  }
  const cursorRaw = params.get("cursor");
  let cursor: AlertListQuery["cursor"] = null;
  if (cursorRaw !== null) {
    const match = ALERT_CURSOR_PATTERN.exec(cursorRaw);
    if (match === null) {
      return null;
    }
    cursor = { createdAt: match[1] as string, id: match[2] as string };
  }
  return { cursor, kind, limit, state, tenantId };
}

interface AlertRow {
  created_at: string;
  id: string;
  kind: string;
  message: string;
  resolution_note: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resource_id: string | null;
  resource_type: string | null;
  severity: string;
  tenant_id: string | null;
}

function alertView(row: AlertRow): AlertView {
  return {
    alertId: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    message: row.message,
    resolution:
      row.resolved_at === null
        ? null
        : { at: row.resolved_at, byUserId: row.resolved_by, note: row.resolution_note },
    resourceId: row.resource_id,
    resourceType: row.resource_type,
    severity: row.severity,
    tenantId: row.tenant_id,
  };
}

/** The manual resolution's audit row (NULL for alerts the system resolved). */
const RESOLUTION_AUDIT = `(SELECT {col} FROM audit_events AS e
   WHERE e.resource_type = 'alert' AND e.resource_id = a.id AND e.action = 'alert.resolve'
   ORDER BY e.created_at DESC LIMIT 1)`;

/** Oldest first, keyset-paginated on (created_at, id). */
export async function listAlerts(
  db: D1Database,
  query: AlertListQuery,
): Promise<{ alerts: AlertView[]; nextCursor: string | null }> {
  const where = [query.state === "open" ? "a.resolved_at IS NULL" : "a.resolved_at IS NOT NULL"];
  const binds: unknown[] = [];
  if (query.kind !== null) {
    where.push("a.kind = ?");
    binds.push(query.kind);
  }
  if (query.tenantId !== null) {
    where.push("a.tenant_id = ?");
    binds.push(query.tenantId);
  }
  if (query.cursor !== null) {
    where.push("(a.created_at, a.id) > (?, ?)");
    binds.push(query.cursor.createdAt, query.cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT a.id, a.tenant_id, a.kind, a.severity, a.message, a.resource_type,
              a.resource_id, a.created_at, a.resolved_at,
              ${RESOLUTION_AUDIT.replace("{col}", "e.actor_user_id")} AS resolved_by,
              ${RESOLUTION_AUDIT.replace("{col}", "e.reason")} AS resolution_note
       FROM alerts AS a
       WHERE ${where.join(" AND ")}
       ORDER BY a.created_at, a.id
       LIMIT ?`,
    )
    .bind(...binds, query.limit + 1)
    .all<AlertRow>();

  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);
  return {
    alerts: page.map(alertView),
    nextCursor:
      rows.results.length > query.limit && last !== undefined
        ? `${last.created_at}~${last.id}`
        : null,
  };
}

export function parseResolveAlertInput(body: unknown): { note: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const keys = Object.keys(body);
  const note = (body as Record<string, unknown>).note;
  if (keys.length !== 1 || keys[0] !== "note" || typeof note !== "string") {
    return null;
  }
  const trimmed = note.trim();
  return trimmed.length > 0 &&
    trimmed.length <= MAX_NOTE_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? { note: trimmed }
    : null;
}

export type ResolveAlertResult =
  | { alert: AlertView; status: "ok" }
  | { status: "conflict" }
  | { status: "not_found" };

/**
 * Resolves one open alert: the audit row and the resolution in ONE batch,
 * both conditional on the alert still being open, so a double click or two
 * operators resolve it once and the second answers 409.
 */
export async function resolveAlert(
  db: D1Database,
  actorUserId: string,
  alertId: string,
  input: { note: string },
  now: number,
): Promise<ResolveAlertResult> {
  const current = await db
    .prepare("SELECT id, tenant_id, kind, resolved_at FROM alerts WHERE id = ? LIMIT 1")
    .bind(alertId)
    .first<{ id: string; kind: string; resolved_at: string | null; tenant_id: string | null }>();
  if (current === null) {
    return { status: "not_found" };
  }
  if (current.resolved_at !== null) {
    return { status: "conflict" };
  }

  const stillOpen = "EXISTS (SELECT 1 FROM alerts WHERE id = ? AND resolved_at IS NULL)";
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO audit_events (
           event_id, tenant_id, actor_user_id, action, resource_type, resource_id,
           reason, request_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, 'alert.resolve', 'alert', ?, ?, ?, ?, ?
         WHERE ${stillOpen}`,
      )
      .bind(
        crypto.randomUUID(),
        current.tenant_id,
        actorUserId,
        alertId,
        input.note,
        crypto.randomUUID(),
        JSON.stringify({ kind: current.kind }),
        now,
        alertId,
      ),
    db
      .prepare(
        // MAX: an alert stamped by a clock slightly ahead of this one must
        // still satisfy resolved_at >= created_at (ISO strings order by time).
        `UPDATE alerts SET resolved_at = MAX(created_at, ?)
         WHERE id = ? AND resolved_at IS NULL
         RETURNING id`,
      )
      .bind(new Date(now).toISOString(), alertId),
  ]);
  if ((results[1]?.results.length ?? 0) === 0) {
    return { status: "conflict" };
  }

  const row = await db
    .prepare(
      `SELECT a.id, a.tenant_id, a.kind, a.severity, a.message, a.resource_type,
              a.resource_id, a.created_at, a.resolved_at,
              ${RESOLUTION_AUDIT.replace("{col}", "e.actor_user_id")} AS resolved_by,
              ${RESOLUTION_AUDIT.replace("{col}", "e.reason")} AS resolution_note
       FROM alerts AS a WHERE a.id = ? LIMIT 1`,
    )
    .bind(alertId)
    .first<AlertRow>();
  return row === null ? { status: "not_found" } : { alert: alertView(row), status: "ok" };
}
