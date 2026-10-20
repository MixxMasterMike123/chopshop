import { alertStatement, type SqlGuard } from "../outbox/outbox";

/**
 * CP11 U7 (audit F5): the alert for an issue the PRINTER reports on an order
 * it holds — Prodigi's `CreatedWithIssues` on creation (dispatch-effect.ts,
 * in the accepting batch), and on every authenticated re-read (prodigi-
 * intake.ts): `status.issues[]`, a `status.details.*` step in `Error`, an
 * item or asset in `Invalid`/`Error`. The order exists at the printer and is
 * never re-submitted under a new key to "fix" it; a human must act (an asset
 * the printer could not fetch, a product it cannot make, a payment hold).
 *
 * ONE alert per (order, code): the id is the dedupe, so the dispatcher and
 * the intake, or two callbacks, never raise the same issue twice. Critical,
 * ids and codes only (0017), the resource the order. No state changes with
 * it: the line keeps what the dispatcher and the intake decided.
 */
export const PRINTER_ORDER_ISSUES_ALERT_KIND = "printer_order_issues";

export function printerOrderIssuesAlertId(orderId: string, code: string): string {
  return `printer-order-issues:${orderId}:${code}`;
}

export function printerOrderIssueAlertStatement(
  db: D1Database,
  input: { code: string; nowMs: number; orderId: string; printerRef: string; tenantId: string },
  where?: SqlGuard,
): D1PreparedStatement {
  return alertStatement(
    db,
    {
      id: printerOrderIssuesAlertId(input.orderId, input.code),
      kind: PRINTER_ORDER_ISSUES_ALERT_KIND,
      message: `Order ${input.orderId}: the printer reports issue ${input.code} on its order ${input.printerRef}. The order exists at the printer and was not sent again. Look the issue up with the printer and resolve it there (re-supply an asset, replace a product, release a hold), or cancel and refund the line.`,
      nowMs: input.nowMs,
      resourceId: input.orderId,
      resourceType: "order",
      severity: "critical",
      tenantId: input.tenantId,
    },
    where,
  );
}
