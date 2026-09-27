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
  | "dispute_recovery_failed"
  | "dispatch_stranded_30m"
  | "order_missing_for_succeeded_pi"
  | "payout_blocked_dispute"
  | "production_snapshot_invalid"
  | "refund_failed_after_success"
  | "refund_unsettled_30m";

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
