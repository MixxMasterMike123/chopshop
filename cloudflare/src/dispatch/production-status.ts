import { openSql, printerShippedOrderStatements } from "../commerce/fulfilment";
import { parsePrinterJobId } from "./snapwear-wire";

/**
 * The printer's production status of ONE job (= one order line), CP6-PS1.
 *
 * `recordProductionStatus` is the ONLY writer of `order_items.production_state`
 * (0022) and of the printer's tracking on the line (0051). Its one caller
 * today is the platform route (src/routes/print-jobs-platform.ts): SnapWear has
 * no status API or webhook, so in v1 the platform operator records what the
 * printer's e-mail says (LAUNCH_TODO A8, decisions table "one-way status flow
 * accepted"). A later automated source (a SnapWear webhook, the A12 mail
 * parser) calls this same function with `actorUserId = null`.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────
 *   - Only a line whose job the printer ACCEPTED moves (`dispatch_state =
 *     'accepted'`: accepted, a duplicate, or resolved accepted by a human).
 *   - States only move forward: in_production → produced → shipped, skipping
 *     allowed (the printer's e-mail may only ever say "shipped"). The same
 *     state again with the same facts is a no-op; a lower one is refused.
 *   - A cancelled order or line, and an order refunded to its charge, are
 *     refused: the printer has been (or is being) asked to cancel — a return
 *     case is a human's (PLAN §2.3).
 *   - The tracking number, its address and the carrier come only with
 *     'shipped', and are written once (0051's trigger backs this).
 *
 * ── WHAT A WRITTEN STATE CHANGES ELSEWHERE ──────────────────────────────────
 *   produced / shipped → the cancel route answers 409 return_case
 *                        (src/dispatch/cancellation.ts); a full refund still
 *                        settles but no longer queues a printer cancellation
 *                        (src/commerce/refund-dispatch-stop.ts).
 *   in_production      → neither: the job is the printer's; a cancellation or
 *                        a full refund queues `printer_cancellation`, a human
 *                        cancels it with the printer.
 *   any state          → the withholding is never released
 *                        (src/commerce/withholding-release.ts releasableSql) —
 *                        which an ACCEPTED line already guarantees, so for the
 *                        money nothing changes: the printer is owed either way.
 *   shipped            → the seller may ship / hand over the order once every
 *                        printer line is shipped (src/commerce/fulfilment.ts
 *                        `printer_ships`); an all-printer parcel order is
 *                        recorded shipped in THIS batch, with the buyer's one
 *                        mail (printerShippedOrderStatements).
 *
 * ── ONE BATCH ───────────────────────────────────────────────────────────────
 * The audit row, the line update and (for 'shipped') the order's statements,
 * each conditioned on the line still being in the state the decision read, in
 * an order still open: a concurrent change makes the set a no-op and the
 * request is decided again from what is now true (two tries).
 */

export const PRODUCTION_STATES = ["in_production", "produced", "shipped"] as const;

export type ProductionState = (typeof PRODUCTION_STATES)[number];

const RANK: Readonly<Record<ProductionState, number>> = {
  in_production: 1,
  produced: 2,
  shipped: 3,
};

export function isProductionState(value: unknown): value is ProductionState {
  return typeof value === "string" && (PRODUCTION_STATES as readonly string[]).includes(value);
}

export interface ProductionStatusInput {
  carrier: string | null;
  state: ProductionState;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** undefined / null ⇒ absent (null); a clean trimmed string ⇒ it; else invalid. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text.length === 0 || text.length > max || CONTROL_CHARACTERS.test(text)
    ? undefined
    : text;
}

/** An https address without credentials or spaces, as 0051's CHECK requires. */
function optionalTrackingUrl(value: unknown): string | null | undefined {
  const text = optionalText(value, 500);
  if (text === null || text === undefined) {
    return text;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    !text.includes(" ") &&
    text.startsWith("https://")
    ? text
    : undefined;
}

/**
 * Exactly `{ state, trackingNumber?, trackingUrl?, carrier? }`. The tracking
 * fields belong to a parcel, so they are refused with any other state.
 */
export function parseProductionStatusInput(body: unknown): ProductionStatusInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["carrier", "state", "trackingNumber", "trackingUrl"].includes(key),
    )
  ) {
    return null;
  }
  if (!isProductionState(record.state)) {
    return null;
  }
  const trackingNumber = optionalText(record.trackingNumber, 100);
  const carrier = optionalText(record.carrier, 60);
  const trackingUrl = optionalTrackingUrl(record.trackingUrl);
  if (trackingNumber === undefined || carrier === undefined || trackingUrl === undefined) {
    return null;
  }
  if (
    record.state !== "shipped" &&
    (trackingNumber !== null || carrier !== null || trackingUrl !== null)
  ) {
    return null;
  }
  return { carrier, state: record.state, trackingNumber, trackingUrl };
}

export type ProductionStatusRefusal =
  | "backwards"
  | "cancelled"
  | "not_accepted"
  | "refunded"
  | "tracking_differs";

export interface ProductionLineFacts {
  carrier: string | null;
  /** The order was cancelled, or this line's dispatch was. */
  cancelled: boolean;
  dispatchState: string | null;
  /** The order is refunded to its charge. */
  refunded: boolean;
  state: ProductionState | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

/** Pure: "move", "unchanged", or why not. */
export function decideProductionStatus(
  facts: ProductionLineFacts,
  input: ProductionStatusInput,
): ProductionStatusRefusal | "move" | "unchanged" {
  // A repeat is answered from what is recorded, whatever happened since: the
  // fact stands, and idempotency is worth more than a fresh refusal.
  if (facts.state === input.state) {
    return facts.trackingNumber === input.trackingNumber &&
      facts.carrier === input.carrier &&
      facts.trackingUrl === input.trackingUrl
      ? "unchanged"
      : "tracking_differs";
  }
  if (facts.cancelled) {
    return "cancelled";
  }
  if (facts.refunded) {
    return "refunded";
  }
  if (facts.dispatchState !== "accepted") {
    return "not_accepted";
  }
  if (facts.state !== null && RANK[input.state] < RANK[facts.state]) {
    return "backwards";
  }
  return "move";
}

export interface PrintJobStatusView {
  carrier: string | null;
  jobId: string;
  lineNo: number;
  orderId: string;
  state: ProductionState | null;
  tenantId: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

export type RecordProductionStatusResult =
  | { job: PrintJobStatusView; orderShipped: boolean; status: "changed" }
  | { job: PrintJobStatusView; status: "unchanged" }
  | { reason: ProductionStatusRefusal; status: "refused" }
  /** Lost a race twice; nothing was written. The caller may simply retry. */
  | { status: "conflict" }
  | { status: "not_found" };

interface LineRow {
  cancelled: number;
  dispatch_state: string | null;
  order_item_id: string;
  printer_carrier: string | null;
  printer_tracking_number: string | null;
  printer_tracking_url: string | null;
  production_state: ProductionState | null;
  refunded: number;
  tenant_id: string;
}

/** The order is refunded to its charge. Alias `o`. */
function refundedSql(o: string): string {
  return `(${o}.status = 'refunded'
           OR (${o}.charged_minor > 0 AND ${o}.refund_succeeded_minor >= ${o}.charged_minor))`;
}

/**
 * The PRINTER line of a job id, across shops (the caller is the platform): a
 * line that is not a print-on-demand line has no job, so it is not found.
 */
async function readLine(
  db: D1Database,
  orderId: string,
  lineNo: number,
): Promise<LineRow | null> {
  return db
    .prepare(
      `SELECT i.order_item_id, i.tenant_id, i.dispatch_state, i.production_state,
              i.printer_tracking_number, i.printer_carrier, i.printer_tracking_url,
              (o.cancelled_at IS NOT NULL OR o.status = 'cancelled'
               OR i.dispatch_state IS 'cancelled') AS cancelled,
              ${refundedSql("o")} AS refunded
       FROM order_items AS i
       JOIN orders AS o ON o.order_id = i.order_id AND o.tenant_id = i.tenant_id
       WHERE i.order_id = ? AND i.item_index = ? AND i.production_json IS NOT NULL
       LIMIT 1`,
    )
    .bind(orderId, lineNo - 1)
    .first<LineRow>();
}

function factsOf(row: LineRow): ProductionLineFacts {
  return {
    cancelled: row.cancelled === 1,
    carrier: row.printer_carrier,
    dispatchState: row.dispatch_state,
    refunded: row.refunded === 1,
    state: row.production_state,
    trackingNumber: row.printer_tracking_number,
    trackingUrl: row.printer_tracking_url,
  };
}

function viewOf(
  jobId: string,
  orderId: string,
  lineNo: number,
  tenantId: string,
  line: Pick<ProductionLineFacts, "carrier" | "state" | "trackingNumber" | "trackingUrl">,
): PrintJobStatusView {
  return {
    carrier: line.carrier,
    jobId,
    lineNo,
    orderId,
    state: line.state,
    tenantId,
    trackingNumber: line.trackingNumber,
    trackingUrl: line.trackingUrl,
  };
}

/** Two tries: a change that lost a race is decided again from the new state. */
const MAX_ATTEMPTS = 2;

export async function recordProductionStatus(
  db: D1Database,
  actorUserId: string | null,
  jobId: string,
  input: ProductionStatusInput,
  nowMs: number,
): Promise<RecordProductionStatusResult> {
  const parsed = parsePrinterJobId(jobId);
  if (parsed === null) {
    return { status: "not_found" };
  }
  const { lineNo, orderId } = parsed;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const row = await readLine(db, orderId, lineNo);
    if (row === null) {
      return { status: "not_found" };
    }
    const facts = factsOf(row);
    const decision = decideProductionStatus(facts, input);
    if (decision === "unchanged") {
      return { job: viewOf(jobId, orderId, lineNo, row.tenant_id, facts), status: "unchanged" };
    }
    if (decision !== "move") {
      return { reason: decision, status: "refused" };
    }

    const tenantId = row.tenant_id;
    const auditEventId = crypto.randomUUID();
    // The line is still as decided, accepted, in an order still open.
    const guard = `EXISTS (
        SELECT 1 FROM order_items AS g
        JOIN orders AS go ON go.order_id = g.order_id AND go.tenant_id = g.tenant_id
        WHERE g.order_item_id = ? AND g.tenant_id = ?
          AND g.production_state IS ?
          AND g.dispatch_state = 'accepted'
          AND ${openSql("go")}
      )`;
    const guardBinds = [row.order_item_id, tenantId, facts.state];

    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO audit_events (
             event_id, tenant_id, actor_user_id, action, resource_type, resource_id,
             reason, request_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, 'print_job.status', 'print_job', ?, NULL, ?, ?, ?
           WHERE ${guard}`,
        )
        .bind(
          auditEventId,
          tenantId,
          actorUserId,
          jobId,
          crypto.randomUUID(),
          // Ids and states only: the tracking stays on the line.
          JSON.stringify({
            from: facts.state,
            lineNo,
            orderId,
            source: actorUserId === null ? "printer" : "platform",
            to: input.state,
          }),
          nowMs,
          ...guardBinds,
        ),
      db
        .prepare(
          `UPDATE order_items
           SET production_state = ?,
               printer_tracking_number = ?,
               printer_carrier = ?,
               printer_tracking_url = ?,
               updated_at = MAX(updated_at, ?)
           WHERE order_item_id = ? AND tenant_id = ? AND ${guard}`,
        )
        .bind(
          input.state,
          input.trackingNumber,
          input.carrier,
          input.trackingUrl,
          nowMs,
          row.order_item_id,
          tenantId,
          ...guardBinds,
        ),
    ];

    const shipping =
      input.state === "shipped"
        ? await printerShippedOrderStatements(db, {
            actorUserId,
            // THIS batch moved the line: its audit row exists.
            after: {
              binds: [auditEventId],
              sql: "EXISTS (SELECT 1 FROM audit_events WHERE event_id = ?)",
            },
            nowMs,
            orderId,
            tenantId,
          })
        : null;
    statements.push(...(shipping?.statements ?? []));

    const results = await db.batch(statements);
    // Rule 5: D1 counts trigger rows too, so only "nothing" is compared.
    if (results[1]?.meta.changes === 0) {
      continue;
    }
    return {
      job: viewOf(jobId, orderId, lineNo, tenantId, {
        carrier: input.carrier,
        state: input.state,
        trackingNumber: input.trackingNumber,
        trackingUrl: input.trackingUrl,
      }),
      orderShipped: shipping !== null && (results.at(-1)?.meta.changes ?? 0) !== 0,
      status: "changed",
    };
  }

  // Lost the race twice: answer with what is true now.
  const row = await readLine(db, orderId, lineNo);
  if (row === null) {
    return { status: "not_found" };
  }
  const facts = factsOf(row);
  const decision = decideProductionStatus(facts, input);
  if (decision === "unchanged") {
    return { job: viewOf(jobId, orderId, lineNo, row.tenant_id, facts), status: "unchanged" };
  }
  return decision === "move" ? { status: "conflict" } : { reason: decision, status: "refused" };
}
