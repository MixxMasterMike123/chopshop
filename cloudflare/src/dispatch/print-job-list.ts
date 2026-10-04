import { isPrinterId } from "../pod/printers";
import { parseTenantIdPathSegment } from "../platform/provision-tenants";
import { isProductionState, type PrinterException, type ProductionState } from "./production-status";
import { parsePrinterJobId, printerJobId } from "./snapwear-wire";

/**
 * The platform's list of print jobs (CP5-WK; CP6_PS1_REPORT "Follow-ups": the
 * console's control for POST /v1/platform/print-jobs/:jobId/status). A job is
 * ONE printer line (`{orderId}-{lineNo}`, PLAN §2.3): an order line with a
 * production snapshot, in any shop.
 *
 *   GET /v1/platform/print-jobs[?state][&dispatchState][&exception][&tenantId]
 *                              [&printerId][&cursor][&limit=1..100]
 *
 * ── WHAT A ROW CARRIES ──────────────────────────────────────────────────────
 * What the status route needs (the job id, the production state, the
 * printer's tracking and, CP6-PS3, the printer's exception and its
 * resolution, named as that route's `job` names them) and what a
 * person needs to recognise the line (the shop, the order number, the
 * product, the quantity, the printer, the dispatch state). Named columns
 * only. NEVER selected: `production_json` (the line's frozen production cost,
 * withholding and print-file keys), the order's money and cost totals, any
 * tier, price, margin or commission, and anything of the buyer — the platform
 * orders list carries the recipient; this list carries none of it. The
 * printer id is the one value read out of the order's snapshot, inside SQL
 * (as platform-orders.ts reads it).
 *
 * ── ORDER AND INDEXES ───────────────────────────────────────────────────────
 * Ordered by job id = (order_id, item_index); the cursor is the last job id of
 * the previous page, so a walk visits every job once. No index on order_items
 * leads with dispatch_state or production_state, and order_items has no time
 * index, so the order is the one an existing index serves (0011, 0022):
 *   tenantId + dispatchState   order_items_tenant_dispatch_idx
 *                              (tenant_id, dispatch_state, order_id): two
 *                              equality probes, rows already in order_id
 *                              order, the cursor a range on order_id
 *   tenantId alone             the same index on its tenant prefix; the
 *                              shop's lines are then sorted (bounded by the
 *                              shop's size)
 *   no tenantId (any other)    the UNIQUE (order_id, item_index) index, walked
 *                              in order from the cursor; every other filter
 *                              is checked per row, so a page reads lines until
 *                              it has `limit + 1` matches — at worst every
 *                              order line (CP5_WK_REPORT: the index that would
 *                              make these selective needs a migration)
 * `state`, `exception` and `printerId` are never in an index (the printer is
 * inside the order's snapshot): they are checked on the rows the path above
 * yields.
 * order_items is the outer loop (CROSS JOIN pins it); the order, the shop and
 * the variant are primary-key lookups.
 */

export const PRINT_JOB_LIST_LIMIT = 50;
const MAX_PRINT_JOB_LIST_LIMIT = 100;
const QUERY_KEYS = ["cursor", "dispatchState", "exception", "limit", "printerId", "state", "tenantId"] as const;

/** The line's dispatch states (0022's CHECK). */
export const LINE_DISPATCH_STATES = [
  "accepted",
  "cancelled",
  "failed",
  "pending",
  "submitting",
  "unknown",
] as const;

export type LineDispatchState = (typeof LINE_DISPATCH_STATES)[number];

/** `none` filters for the column's NULL: no state recorded yet. */
type Filter<T> = T | "none" | null;

export interface PrintJobListQuery {
  cursor: { lineNo: number; orderId: string } | null;
  /** The line's dispatch state; `none` = no dispatch recorded (queued, or held for a printer before its first call). */
  dispatchState: Filter<LineDispatchState>;
  /** CP6-PS3: the printer's exception (resolved or not); `none` = the printer reported none. */
  exception: Filter<PrinterException>;
  limit: number;
  printerId: string | null;
  /** The line's production state; `none` = the printer has reported nothing yet. */
  state: Filter<ProductionState>;
  tenantId: string | null;
}

function parseFilter<T extends string>(
  raw: string | null,
  accept: (value: string) => value is T,
): Filter<T> | undefined {
  if (raw === null) {
    return null;
  }
  return raw === "none" || accept(raw) ? raw : undefined;
}

function isLineDispatchState(value: string): value is LineDispatchState {
  return (LINE_DISPATCH_STATES as readonly string[]).includes(value);
}

function isPrinterException(value: string): value is PrinterException {
  return value === "out_of_stock";
}

/**
 * Every key optional; an unknown key, a repeated key or a malformed value is a
 * 400, never ignored: a typo in a filter must not turn into "every job".
 */
export function parsePrintJobListQuery(url: URL): PrintJobListQuery | null {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!(QUERY_KEYS as readonly string[]).includes(key) || params.getAll(key).length > 1) {
      return null;
    }
  }

  const state = parseFilter(params.get("state"), isProductionState);
  const dispatchState = parseFilter(params.get("dispatchState"), isLineDispatchState);
  const exception = parseFilter(params.get("exception"), isPrinterException);
  if (state === undefined || dispatchState === undefined || exception === undefined) {
    return null;
  }

  const tenantIdRaw = params.get("tenantId");
  const tenantId = tenantIdRaw === null ? null : parseTenantIdPathSegment(tenantIdRaw);
  const printerId = params.get("printerId");
  if ((tenantIdRaw !== null && tenantId === null) || (printerId !== null && !isPrinterId(printerId))) {
    return null;
  }

  const cursorRaw = params.get("cursor");
  const cursor = cursorRaw === null ? null : parsePrinterJobId(cursorRaw);
  if (cursorRaw !== null && cursor === null) {
    return null;
  }

  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? PRINT_JOB_LIST_LIMIT : Number(limitRaw);
  if (
    (limitRaw !== null && !/^\d{1,3}$/.test(limitRaw)) ||
    limit < 1 ||
    limit > MAX_PRINT_JOB_LIST_LIMIT
  ) {
    return null;
  }

  return { cursor, dispatchState, exception, limit, printerId, state, tenantId };
}

export interface PrintJobListItem {
  carrier: string | null;
  /** The line's creation = the order's (ISO). */
  createdAt: string;
  dispatchedAt: string | null;
  dispatchState: LineDispatchState | null;
  /** CP6-PS3: what the printer reported after accepting the job, or null. */
  exception: PrinterException | null;
  /** CP6-PS3: when a human closed the exception without the printer sending the line (ISO), or null. */
  exceptionResolvedAt: string | null;
  jobId: string;
  lineNo: number;
  /** The product's name as frozen on the line. */
  name: string;
  orderId: string;
  orderNumber: string;
  /** The order's status: the status route refuses a cancelled order and one refunded to its charge. */
  orderStatus: string;
  /** The printer's own reference for the accepted job (null for a recognised duplicate). */
  printerJobRef: string | null;
  /** The order's printer, from its frozen snapshot. */
  printerId: string | null;
  quantity: number;
  shopName: string | null;
  /** The line's SKU as frozen on the line. */
  sku: string;
  state: ProductionState | null;
  tenantId: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  /** Moves only when the production state is recorded (the one writer that stamps it). */
  updatedAt: string;
  /** The variant's label as the catalogue holds it NOW (the order freezes none); null without a variant. */
  variantLabel: string | null;
}

interface PrintJobRow {
  created_at: number;
  dispatch_state: LineDispatchState | null;
  dispatched_at: string | null;
  item_index: number;
  name: string;
  order_id: string;
  order_number: string;
  order_status: string;
  printer_carrier: string | null;
  printer_exception: PrinterException | null;
  printer_exception_resolved_at: string | null;
  printer_id: string | null;
  printer_job_ref: string | null;
  printer_tracking_number: string | null;
  printer_tracking_url: string | null;
  production_state: ProductionState | null;
  quantity: number;
  shop_name: string | null;
  sku: string;
  tenant_id: string;
  updated_at: number;
  variant_label: string | null;
}

/** The page's SQL and binds. Exported so a test can pin the query plan of each path. */
export function printJobListSql(query: PrintJobListQuery): { binds: unknown[]; sql: string } {
  const where = ["i.production_json IS NOT NULL"];
  const binds: unknown[] = [];
  if (query.tenantId !== null) {
    where.push("i.tenant_id = ?");
    binds.push(query.tenantId);
  }
  if (query.dispatchState === "none") {
    where.push("i.dispatch_state IS NULL");
  } else if (query.dispatchState !== null) {
    where.push("i.dispatch_state = ?");
    binds.push(query.dispatchState);
  }
  if (query.state === "none") {
    where.push("i.production_state IS NULL");
  } else if (query.state !== null) {
    where.push("i.production_state = ?");
    binds.push(query.state);
  }
  if (query.exception === "none") {
    where.push("i.printer_exception IS NULL");
  } else if (query.exception !== null) {
    where.push("i.printer_exception = ?");
    binds.push(query.exception);
  }
  if (query.printerId !== null) {
    where.push("json_extract(o.production_snapshot_json, '$.printer') = ?");
    binds.push(query.printerId);
  }
  if (query.cursor !== null) {
    // A range on order_id (which either index can seek), then the rest of
    // the cursor's own order: never a row value, which only the
    // (order_id, item_index) index could use.
    where.push("i.order_id >= ?", "(i.order_id > ? OR i.item_index > ?)");
    binds.push(query.cursor.orderId, query.cursor.orderId, query.cursor.lineNo - 1);
  }

  return {
    binds: [...binds, query.limit + 1],
    sql: `SELECT i.order_id, i.item_index, i.tenant_id, t.shop_name, o.order_number,
            o.status AS order_status,
            i.name, i.sku, v.label AS variant_label, i.quantity,
            json_extract(o.production_snapshot_json, '$.printer') AS printer_id,
            i.printer_job_ref, i.dispatch_state, i.dispatched_at,
            i.production_state, i.printer_tracking_number,
            i.printer_tracking_url, i.printer_carrier,
            i.printer_exception, i.printer_exception_resolved_at,
            i.created_at, i.updated_at
     FROM order_items AS i
     CROSS JOIN orders AS o ON o.order_id = i.order_id AND o.tenant_id = i.tenant_id
     CROSS JOIN tenants AS t ON t.tenant_id = i.tenant_id
     LEFT JOIN product_variants AS v
       ON v.variant_id = i.variant_id AND v.tenant_id = i.tenant_id
     WHERE ${where.join(" AND ")}
     ORDER BY i.order_id, i.item_index
     LIMIT ?`,
  };
}

export async function listPrintJobs(
  db: D1Database,
  query: PrintJobListQuery,
): Promise<{ jobs: PrintJobListItem[]; nextCursor: string | null }> {
  const { binds, sql } = printJobListSql(query);
  const rows = await db.prepare(sql).bind(...binds).all<PrintJobRow>();
  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);
  return {
    // Field by field: no column reaches the answer by spreading a row.
    jobs: page.map((row) => ({
      carrier: row.printer_carrier,
      createdAt: new Date(row.created_at).toISOString(),
      dispatchedAt: row.dispatched_at,
      dispatchState: row.dispatch_state,
      exception: row.printer_exception,
      exceptionResolvedAt: row.printer_exception_resolved_at,
      jobId: printerJobId(row.order_id, row.item_index + 1),
      lineNo: row.item_index + 1,
      name: row.name,
      orderId: row.order_id,
      orderNumber: row.order_number,
      orderStatus: row.order_status,
      printerId: row.printer_id,
      printerJobRef: row.printer_job_ref,
      quantity: row.quantity,
      shopName: row.shop_name,
      sku: row.sku,
      state: row.production_state,
      tenantId: row.tenant_id,
      trackingNumber: row.printer_tracking_number,
      trackingUrl: row.printer_tracking_url,
      updatedAt: new Date(row.updated_at).toISOString(),
      variantLabel: row.variant_label,
    })),
    nextCursor:
      rows.results.length > query.limit && last !== undefined
        ? printerJobId(last.order_id, last.item_index + 1)
        : null,
  };
}
