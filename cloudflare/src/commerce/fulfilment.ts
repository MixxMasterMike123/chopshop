import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";

/**
 * The seller's fulfilment of an order (CP5-WB, migration 0046).
 *
 *   POST /v1/admin/orders/:orderId/fulfilment
 *        { to, trackingNumber?, carrier?, note? } + Idempotency-Key: <uuid>
 *
 * ── TWO COLUMNS, TWO OWNERS ─────────────────────────────────────────────────
 * `orders.status` is the money path's (webhook, refunds): paid,
 * partially_refunded, refunded. `orders.fulfilment_status` is this module's,
 * and nothing here writes `status`. A refund therefore never erases that an
 * order was shipped, and a shipment never erases that it was refunded.
 *
 * ── THE TRANSITIONS ─────────────────────────────────────────────────────────
 *   unfulfilled       → processing | shipped | ready_for_pickup
 *   processing        → shipped | ready_for_pickup
 *   shipped           → shipped (another parcel: a tracking number is
 *                       required) | delivered | completed
 *   ready_for_pickup  → delivered | completed
 *   delivered         → completed
 *   completed         → (none)
 * Nothing goes back. Refused, whatever the edge:
 *   order_closed       the order is cancelled (`cancelled_at`), or refunded to
 *                      its charge (status 'refunded', or refund_succeeded ≥
 *                      charged > 0)
 *   delivery_method    `shipped` of a pickup order, `ready_for_pickup` of a
 *                      parcel
 *   transition         an edge not in the table
 *   tracking_required  shipped → shipped without a tracking number
 *   printer_ships      `shipped` or `ready_for_pickup` while a print-on-demand
 *                      line (`order_items.production_json` set) has not been
 *                      sent by the printer. THE PRINTER SHIPS every POD line:
 *                      for a parcel to the buyer (the job carries the order's
 *                      recipient, src/dispatch/dispatch-effect.ts
 *                      readDispatchShipTo), for a pickup order to the shop (the
 *                      job carries no address). So the seller cannot ship a
 *                      POD line nor hand one over before it left the printer;
 *                      the line's state comes from the dispatch
 *                      (`order_items.production_state` 'shipped', written by
 *                      the platform's side, not by this route:
 *                      src/dispatch/production-status.ts). A line whose
 *                      dispatch was cancelled does not count. `processing` is
 *                      always open to the seller.
 *
 * ── THE ONE CHANGE NOT MADE BY THE SELLER (CP6-PS1) ─────────────────────────
 * An order that is NOTHING but printer lines and goes by PARCEL has nothing
 * left for the seller to send: when the printer sends its last line, that
 * line's batch also records the order `shipped` — the same history row, audit
 * row, buyer's mail (`email.order_status`) and update as the seller's change,
 * once (printerShippedOrderStatements below). Every other order (a pickup, or
 * one with a line the seller sends) waits for the seller, exactly as above.
 *
 * ── ONE BATCH ───────────────────────────────────────────────────────────────
 * The history row, the shipment, the audit row (with the acting-as grant), the
 * outbox row `email.order_status` (ids only; its consumer is unit WE's) and
 * the update of the order are one `batch()`, every statement conditioned on
 * the SAME guard: the order is still in the state the decision read, still
 * open, and (for `shipped` / `ready_for_pickup`) has no unsent POD line. The update is
 * last, so the statements before it read the old state; a concurrent refund,
 * cancellation or change that lands first makes the whole set a no-op, and
 * the request is decided again from what is now true.
 */

export const FULFILMENT_STATES = [
  "unfulfilled",
  "processing",
  "shipped",
  "ready_for_pickup",
  "delivered",
  "completed",
] as const;

export type FulfilmentState = (typeof FULFILMENT_STATES)[number];

export type FulfilmentTarget = Exclude<FulfilmentState, "unfulfilled">;

export const FULFILMENT_TRANSITIONS: Readonly<Record<FulfilmentState, readonly FulfilmentTarget[]>> = {
  completed: [],
  delivered: ["completed"],
  processing: ["shipped", "ready_for_pickup"],
  ready_for_pickup: ["delivered", "completed"],
  shipped: ["shipped", "delivered", "completed"],
  unfulfilled: ["processing", "shipped", "ready_for_pickup"],
};

export type FulfilmentRefusal =
  | "delivery_method"
  | "order_closed"
  | "printer_ships"
  | "tracking_required"
  | "transition";

export interface FulfilmentInput {
  carrier: string | null;
  note: string | null;
  to: FulfilmentTarget;
  trackingNumber: string | null;
}

export function isFulfilmentState(value: unknown): value is FulfilmentState {
  return typeof value === "string" && (FULFILMENT_STATES as readonly string[]).includes(value);
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text.length === 0 || text.length > max || CONTROL_CHARACTERS.test(text) ? undefined : text;
}

/**
 * Exactly `{ to, trackingNumber?, carrier?, note? }`. A tracking number or a
 * carrier belongs to a shipment, so either is refused with any other `to`.
 */
export function parseFulfilmentInput(body: unknown): FulfilmentInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["carrier", "note", "to", "trackingNumber"].includes(key))) {
    return null;
  }
  if (!isFulfilmentState(record.to) || record.to === "unfulfilled") {
    return null;
  }
  const trackingNumber = optionalText(record.trackingNumber, 100);
  const carrier = optionalText(record.carrier, 60);
  const note = optionalText(record.note, 500);
  if (trackingNumber === undefined || carrier === undefined || note === undefined) {
    return null;
  }
  if (record.to !== "shipped" && (trackingNumber !== null || carrier !== null)) {
    return null;
  }
  return { carrier, note, to: record.to, trackingNumber };
}

export interface FulfilmentFacts {
  cancelledAt: string | null;
  chargedMinor: number;
  deliveryMethod: string;
  fulfilment: FulfilmentState;
  refundSucceededMinor: number;
  status: string;
  /** POD lines of the order the printer has not sent (and not cancelled). */
  unsentPodLines: number;
}

/** Pure: may `input` move an order with `facts`? null = yes. */
export function decideFulfilment(
  facts: FulfilmentFacts,
  input: Pick<FulfilmentInput, "to" | "trackingNumber">,
): FulfilmentRefusal | null {
  if (
    facts.cancelledAt !== null ||
    facts.status === "refunded" ||
    facts.status === "cancelled" ||
    (facts.chargedMinor > 0 && facts.refundSucceededMinor >= facts.chargedMinor)
  ) {
    return "order_closed";
  }
  if (
    (input.to === "shipped" && facts.deliveryMethod !== "shipping") ||
    (input.to === "ready_for_pickup" && facts.deliveryMethod !== "pickup")
  ) {
    return "delivery_method";
  }
  if (!FULFILMENT_TRANSITIONS[facts.fulfilment].includes(input.to)) {
    return "transition";
  }
  if (input.to === "shipped" && facts.fulfilment === "shipped" && input.trackingNumber === null) {
    return "tracking_required";
  }
  if ((input.to === "shipped" || input.to === "ready_for_pickup") && facts.unsentPodLines > 0) {
    return "printer_ships";
  }
  return null;
}

/** A POD line (`production_json` set) the printer has not sent, of alias `o`. */
function unsentPodLinesSql(o: string): string {
  return `SELECT COUNT(*) FROM order_items AS u
          WHERE u.order_id = ${o}.order_id AND u.tenant_id = ${o}.tenant_id
            AND u.production_json IS NOT NULL
            AND u.production_state IS NOT 'shipped'
            AND u.dispatch_state IS NOT 'cancelled'`;
}

/**
 * The order is open: not cancelled, not refunded to its charge. Alias `o`.
 * Also the printer status intake's guard (src/dispatch/production-status.ts).
 */
export function openSql(o: string): string {
  return `${o}.cancelled_at IS NULL
          AND ${o}.status NOT IN ('refunded', 'cancelled')
          AND NOT (${o}.charged_minor > 0 AND ${o}.refund_succeeded_minor >= ${o}.charged_minor)`;
}

async function readFacts(
  db: D1Database,
  tenantId: string,
  orderId: string,
): Promise<FulfilmentFacts | null> {
  const row = await db
    .prepare(
      `SELECT o.fulfilment_status, o.delivery_method, o.status, o.cancelled_at,
              o.charged_minor, o.refund_succeeded_minor,
              (${unsentPodLinesSql("o")}) AS unsent_pod_lines
       FROM orders AS o
       WHERE o.order_id = ? AND o.tenant_id = ?
       LIMIT 1`,
    )
    .bind(orderId, tenantId)
    .first<{
      cancelled_at: string | null;
      charged_minor: number;
      delivery_method: string;
      fulfilment_status: FulfilmentState;
      refund_succeeded_minor: number;
      status: string;
      unsent_pod_lines: number;
    }>();
  return row === null
    ? null
    : {
        cancelledAt: row.cancelled_at,
        chargedMinor: row.charged_minor,
        deliveryMethod: row.delivery_method,
        fulfilment: row.fulfilment_status,
        refundSucceededMinor: row.refund_succeeded_minor,
        status: row.status,
        unsentPodLines: row.unsent_pod_lines,
      };
}

export interface FulfilmentChange {
  at: string;
  from: FulfilmentState;
  orderId: string;
  shipment: { carrier: string | null; createdAt: string; trackingNumber: string | null } | null;
  to: FulfilmentTarget;
}

export type FulfilmentResult =
  | { change: FulfilmentChange; status: "changed" }
  | { change: FulfilmentChange; status: "replayed" }
  | { reason: FulfilmentRefusal; status: "refused" }
  | { status: "key_conflict" }
  | { status: "not_found" };

/** The fingerprint a key stands for: the order and the whole request. */
export async function fulfilmentRequestHash(orderId: string, input: FulfilmentInput): Promise<string> {
  const canonical = JSON.stringify([
    orderId,
    input.to,
    input.trackingNumber,
    input.carrier,
    input.note,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface RecordedRow {
  created_at: number;
  from_status: FulfilmentState;
  history_id: string;
  order_id: string;
  request_hash: string;
  s_carrier: string | null;
  s_created_at: string | null;
  s_tracking_number: string | null;
  to_status: FulfilmentTarget;
}

async function findByKey(
  db: D1Database,
  tenantId: string,
  clientKey: string,
): Promise<RecordedRow | null> {
  return db
    .prepare(
      `SELECT h.history_id, h.order_id, h.from_status, h.to_status, h.created_at,
              h.request_hash, s.tracking_number AS s_tracking_number,
              s.carrier AS s_carrier, s.created_at AS s_created_at
       FROM order_status_history AS h
       LEFT JOIN order_shipments AS s
         ON s.history_id = h.history_id AND s.tenant_id = h.tenant_id
       WHERE h.tenant_id = ? AND h.client_key = ? AND h.track = 'fulfilment'
       LIMIT 1`,
    )
    .bind(tenantId, clientKey)
    .first<RecordedRow>();
}

function changeFromRow(row: RecordedRow): FulfilmentChange {
  return {
    at: new Date(row.created_at).toISOString(),
    from: row.from_status,
    orderId: row.order_id,
    shipment:
      row.s_created_at === null
        ? null
        : {
            carrier: row.s_carrier,
            createdAt: row.s_created_at,
            trackingNumber: row.s_tracking_number,
          },
    to: row.to_status,
  };
}

function replay(row: RecordedRow, requestHash: string): FulfilmentResult {
  return row.request_hash === requestHash
    ? { change: changeFromRow(row), status: "replayed" }
    : { status: "key_conflict" };
}

function isClientKeyCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("UNIQUE constraint failed") &&
    message.includes("order_status_history.client_key")
  );
}

/** Two tries: a change that lost a race is decided again from the new state. */
const MAX_ATTEMPTS = 2;

export async function changeFulfilment(
  db: D1Database,
  principal: TenantAdminPrincipal,
  orderId: string,
  input: FulfilmentInput,
  clientKey: string,
  nowMs: number,
): Promise<FulfilmentResult> {
  const tenantId = principal.tenantId;
  const requestHash = await fulfilmentRequestHash(orderId, input);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Read again on a retry too: the batch that beat this one may be a
    // concurrent request with the SAME key, whose change is this caller's.
    const existing = await findByKey(db, tenantId, clientKey);
    if (existing !== null) {
      return replay(existing, requestHash);
    }
    const facts = await readFacts(db, tenantId, orderId);
    if (facts === null) {
      return { status: "not_found" };
    }
    const refusal = decideFulfilment(facts, input);
    if (refusal !== null) {
      return { reason: refusal, status: "refused" };
    }

    const historyId = crypto.randomUUID();
    const atIso = new Date(nowMs).toISOString();
    const podGuard =
      input.to === "shipped" || input.to === "ready_for_pickup"
        ? `AND (${unsentPodLinesSql("g")}) = 0`
        : "";
    // The guard every statement of the batch repeats (see the header).
    const guard = `EXISTS (
        SELECT 1 FROM orders AS g
        WHERE g.order_id = ? AND g.tenant_id = ? AND g.fulfilment_status = ?
          AND ${openSql("g")} ${podGuard}
      )`;
    const guardBinds = [orderId, tenantId, facts.fulfilment];

    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO order_status_history (
             history_id, order_id, tenant_id, from_status, to_status,
             actor_user_id, reason, created_at, track, client_key, request_hash
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'fulfilment', ?, ?
           WHERE ${guard}`,
        )
        .bind(
          historyId,
          orderId,
          tenantId,
          facts.fulfilment,
          input.to,
          principal.userId,
          input.note,
          nowMs,
          clientKey,
          requestHash,
          ...guardBinds,
        ),
    ];
    if (input.to === "shipped") {
      statements.push(
        db
          .prepare(
            `INSERT INTO order_shipments (
               shipment_id, tenant_id, order_id, history_id, tracking_number,
               carrier, created_at, created_by
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${guard}`,
          )
          .bind(
            crypto.randomUUID(),
            tenantId,
            orderId,
            historyId,
            input.trackingNumber,
            input.carrier,
            atIso,
            principal.userId,
            ...guardBinds,
          ),
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO audit_events (
             event_id, tenant_id, actor_user_id, action, resource_type, resource_id,
             reason, request_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, 'order.fulfilment', 'order', ?, ?, ?, ?, ?
           WHERE ${guard}`,
        )
        .bind(
          crypto.randomUUID(),
          tenantId,
          principal.userId,
          orderId,
          input.note,
          crypto.randomUUID(),
          auditMetadataJson(principal, { from: facts.fulfilment, historyId, to: input.to }),
          nowMs,
          ...guardBinds,
        ),
      // The buyer's status mail: ids only. Event types are free text (0021);
      // src/outbox/email-effect.ts consumes it, and the route nudges it.
      db
        .prepare(
          `INSERT INTO outbox_events (
             outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
             dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at
           )
           SELECT ?, ?, 'email.order_status', 'order', ?, ?, ?, 'pending', ?, ?, ?
           WHERE ${guard}`,
        )
        .bind(
          `email-order-status:${historyId}`,
          tenantId,
          orderId,
          `email.order_status:${historyId}`,
          JSON.stringify({ historyId, orderId }),
          nowMs,
          nowMs,
          nowMs,
          ...guardBinds,
        ),
      db
        .prepare(
          `UPDATE orders
           SET fulfilment_status = ?, updated_at = MAX(updated_at, ?)
           WHERE order_id = ? AND tenant_id = ? AND ${guard}`,
        )
        .bind(input.to, nowMs, orderId, tenantId, ...guardBinds),
    );

    let results: D1Result[];
    try {
      results = await db.batch(statements);
    } catch (error) {
      // A concurrent request with the same key committed first: this batch
      // aborted whole, so answer with that change.
      if (!isClientKeyCollision(error)) {
        throw error;
      }
      const winner = await findByKey(db, tenantId, clientKey);
      if (winner === null) {
        throw error;
      }
      return replay(winner, requestHash);
    }

    // Rule 5: D1 counts trigger rows too, so only "nothing" is compared.
    if (results.at(-1)?.meta.changes === 0) {
      continue;
    }
    return {
      change: {
        at: atIso,
        from: facts.fulfilment,
        orderId,
        shipment:
          input.to === "shipped"
            ? { carrier: input.carrier, createdAt: atIso, trackingNumber: input.trackingNumber }
            : null,
        to: input.to,
      },
      status: "changed",
    };
  }

  // Lost the race twice: answer with what is true now.
  const existing = await findByKey(db, tenantId, clientKey);
  if (existing !== null) {
    return replay(existing, requestHash);
  }
  const facts = await readFacts(db, tenantId, orderId);
  if (facts === null) {
    return { status: "not_found" };
  }
  return { reason: decideFulfilment(facts, input) ?? "transition", status: "refused" };
}

// ── the printer sent the whole order (CP6-PS1) ─────────────────────────────

/**
 * The order's `shipped`, recorded in the batch that moves a printer line to
 * 'shipped' (src/dispatch/production-status.ts), when — evaluated AFTER that
 * line's update, inside the batch — ALL of these hold:
 *   - `after` holds (the caller's proof that THIS batch moved the line);
 *   - the order goes by parcel (the printer sent it to the buyer; a pickup
 *     order's print went to the shop, and the seller makes it ready);
 *   - every line is a printer line (no line the seller still has to send);
 *   - no printer line is unsent (unsentPodLinesSql), and one at least is sent;
 *   - the order is open (openSql) and still `unfulfilled` or `processing`.
 * Then, as changeFulfilment does: the history row (track 'fulfilment', the
 * actor = who recorded the printer's status, so the seller reads "platform",
 * or "system" for a future automated source), the audit row, the buyer's
 * `email.order_status` row, and the order update LAST. The fulfilment state
 * guard makes it once per order: a second line, a repeat or a race finds the
 * order `shipped` and writes nothing, and the seller's own later `shipped` is
 * shipped → shipped, which needs a tracking number (another parcel).
 *
 * NO `order_shipments` row: the printer's tracking stays on its line (0051),
 * where no tenant route reads it. A shipment row would put it in the buyer's
 * mail AND the seller's order detail — a decision still owed
 * (docs/cf-port/CP6_PS1_REPORT.md).
 */
export async function printerShippedOrderStatements(
  db: D1Database,
  input: {
    actorUserId: string | null;
    after: { binds: unknown[]; sql: string };
    nowMs: number;
    orderId: string;
    tenantId: string;
  },
): Promise<{ historyId: string; statements: D1PreparedStatement[] }> {
  const { actorUserId, nowMs, orderId, tenantId } = input;
  const historyId = crypto.randomUUID();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(["printer_shipped", orderId, historyId])),
  );
  const requestHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  const shippable = `EXISTS (
      SELECT 1 FROM orders AS g
      WHERE g.order_id = ? AND g.tenant_id = ?
        AND g.delivery_method = 'shipping'
        AND g.fulfilment_status IN ('unfulfilled', 'processing')
        AND ${openSql("g")}
        AND NOT EXISTS (
          SELECT 1 FROM order_items AS n
          WHERE n.order_id = g.order_id AND n.tenant_id = g.tenant_id
            AND n.production_json IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM order_items AS s
          WHERE s.order_id = g.order_id AND s.tenant_id = g.tenant_id
            AND s.production_state = 'shipped'
        )
        AND (${unsentPodLinesSql("g")}) = 0
    ) AND (${input.after.sql})`;
  const shippableBinds = [orderId, tenantId, ...input.after.binds];
  // Every later statement follows the history row this batch wrote.
  const written = `FROM order_status_history AS h
                   WHERE h.history_id = ? AND h.order_id = ? AND h.tenant_id = ?`;
  const writtenBinds = [historyId, orderId, tenantId];

  return {
    historyId,
    statements: [
      db
        .prepare(
          `INSERT INTO order_status_history (
             history_id, order_id, tenant_id, from_status, to_status,
             actor_user_id, reason, created_at, track, client_key, request_hash
           )
           SELECT ?, o.order_id, o.tenant_id, o.fulfilment_status, 'shipped',
                  ?, NULL, ?, 'fulfilment', ?, ?
           FROM orders AS o
           WHERE o.order_id = ? AND o.tenant_id = ? AND ${shippable}`,
        )
        .bind(
          historyId,
          actorUserId,
          nowMs,
          crypto.randomUUID(),
          requestHash,
          orderId,
          tenantId,
          ...shippableBinds,
        ),
      db
        .prepare(
          `INSERT INTO audit_events (
             event_id, tenant_id, actor_user_id, action, resource_type, resource_id,
             reason, request_id, metadata_json, created_at
           )
           SELECT ?, h.tenant_id, ?, 'order.fulfilment', 'order', h.order_id, NULL, ?,
                  json_object('from', h.from_status, 'historyId', h.history_id,
                              'source', 'printer', 'to', 'shipped'),
                  ?
           ${written}`,
        )
        .bind(crypto.randomUUID(), actorUserId, crypto.randomUUID(), nowMs, ...writtenBinds),
      db
        .prepare(
          `INSERT INTO outbox_events (
             outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
             dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at
           )
           SELECT ?, h.tenant_id, 'email.order_status', 'order', h.order_id, ?, ?,
                  'pending', ?, ?, ?
           ${written}`,
        )
        .bind(
          `email-order-status:${historyId}`,
          `email.order_status:${historyId}`,
          JSON.stringify({ historyId, orderId }),
          nowMs,
          nowMs,
          nowMs,
          ...writtenBinds,
        ),
      db
        .prepare(
          `UPDATE orders
           SET fulfilment_status = 'shipped', updated_at = MAX(updated_at, ?)
           WHERE order_id = ? AND tenant_id = ?
             AND fulfilment_status IN ('unfulfilled', 'processing')
             AND EXISTS (SELECT 1 ${written})`,
        )
        .bind(nowMs, orderId, tenantId, ...writtenBinds),
    ],
  };
}

// ── the order read's fulfilment record ─────────────────────────────────────

export interface ShipmentView {
  carrier: string | null;
  createdAt: string;
  trackingNumber: string | null;
}

export interface StatusHistoryView {
  at: string;
  by: "admin" | "platform" | "system";
  from: string | null;
  reason: string | null;
  to: string;
  /** 'payment' (the money path's status) or 'fulfilment' (this module's). */
  track: "fulfilment" | "payment";
}

/** Bounded: an order with more changes than this is not real. */
const MAX_HISTORY_LISTED = 200;
const MAX_SHIPMENTS_LISTED = 50;

/**
 * The shipments and the status history of one order of `tenantId`. Who acted
 * is a KIND (system / admin / platform), never a user id: the shop's admin may
 * not learn another person's id, nor which operator helped.
 */
export async function readOrderFulfilmentRecord(
  db: D1Database,
  tenantId: string,
  orderId: string,
): Promise<{ shipments: ShipmentView[]; statusHistory: StatusHistoryView[] }> {
  const [shipments, history] = await db.batch([
    db
      .prepare(
        `SELECT tracking_number, carrier, created_at
         FROM order_shipments
         WHERE tenant_id = ? AND order_id = ?
         ORDER BY created_at, shipment_id
         LIMIT ?`,
      )
      .bind(tenantId, orderId, MAX_SHIPMENTS_LISTED),
    db
      .prepare(
        `SELECT h.track, h.from_status, h.to_status, h.reason, h.created_at,
                h.actor_user_id IS NULL AS by_system,
                COALESCE(a.account_type = 'platform_admin', 0) AS by_platform
         FROM order_status_history AS h
         LEFT JOIN identity_access AS a ON a.user_id = h.actor_user_id
         WHERE h.tenant_id = ? AND h.order_id = ?
         ORDER BY h.created_at, h.rowid
         LIMIT ?`,
      )
      .bind(tenantId, orderId, MAX_HISTORY_LISTED),
  ]);
  return {
    shipments: (
      (shipments?.results ?? []) as Array<{
        carrier: string | null;
        created_at: string;
        tracking_number: string | null;
      }>
    ).map((row) => ({
      carrier: row.carrier,
      createdAt: row.created_at,
      trackingNumber: row.tracking_number,
    })),
    statusHistory: (
      (history?.results ?? []) as Array<{
        by_platform: number;
        by_system: number;
        created_at: number;
        from_status: string | null;
        reason: string | null;
        to_status: string;
        track: "fulfilment" | "payment";
      }>
    ).map((row) => ({
      at: new Date(row.created_at).toISOString(),
      by: row.by_system === 1 ? "system" : row.by_platform === 1 ? "platform" : "admin",
      from: row.from_status,
      reason: row.reason,
      to: row.to_status,
      track: row.track,
    })),
  };
}
