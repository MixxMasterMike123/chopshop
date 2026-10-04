import type { TenantAdminPrincipal } from "../auth/live-authorization";
import { auditMetadataJson } from "../auth/live-authorization";
import { raiseAlertStatement } from "./money-alerts";
import { disputeBlocksRefund } from "./payouts";
import { fullRefundStopStatements } from "./refund-dispatch-stop";
import type { RefundView, StripeMoneyGateway } from "./stripe-client";
import { StripeGatewayError } from "./stripe-client";

/**
 * Refunds — reserve before Stripe (PLAN §2.3).
 *
 * ── THE RACE THIS FIXES ─────────────────────────────────────────────────────
 * Firebase's connectRefund.ts validates the request against
 * `charged − refundedTotalSek`, calls Stripe, then writes the new cumulative
 * total. Two concurrent partial refunds both pass the validation against the
 * same "before" figure and both reach Stripe: the order can be over-refunded up
 * to Stripe's own ceiling, and the second write overwrites the first's total.
 *
 * Here a request first RESERVES its amount in one D1 batch:
 *
 *   UPDATE orders SET refund_reserved_minor += amount, refund_version += 1,
 *                     last_refund_op_id = <op>
 *    WHERE order_id = ? AND refund_version = <read version>
 *      AND charged − refund_succeeded − refund_reserved >= amount
 *   INSERT refund_operations (<op>, 'reserved') … only if that UPDATE applied
 *
 * D1 runs a batch as one transaction and one database is single-threaded, so
 * of two concurrent reservations exactly one sees the version it read; the
 * other matches zero rows, inserts nothing, re-reads and either fits in what
 * remains or is refused. Only a reserved operation ever reaches Stripe, and it
 * does so with idempotency key = the operation id, so a retried call can never
 * become a second refund.
 *
 * ── SETTLEMENT ──────────────────────────────────────────────────────────────
 * Every later fact about a refund — the API response, `refund.created`,
 * `refund.updated`, `refund.failed`, `charge.refunded`, or the reconciliation
 * cron listing refunds from Stripe — goes through applyRefundFact, which is
 * DEDUPED BY stripe_refund_id and moves the operation through the state machine
 * in 0019 in one batch:
 *
 *   UPDATE refund_operations SET prev_state = state, state = <to>,
 *                                transition_id = <fresh id> …
 *    WHERE id = ? AND state IN (<states that may become <to>>)
 *   UPDATE orders SET <reserved/succeeded deltas computed from prev_state and
 *                      state> … WHERE EXISTS (op with that transition id)
 *
 * The money moves only if THIS batch performed the transition, so a replayed
 * or concurrent fact is a no-op by construction rather than by a read that
 * could be stale. A refund Stripe knows and this worker does not (the Stripe
 * dashboard) is born as an operation from the fact itself, origin 'stripe'.
 *
 * D9: `refund_application_fee` is FALSE — the platform fee (commission +
 * production withholding) is not returned. `reverse_transfer` is TRUE: Stripe
 * reverses the destination transfer proportionally (transfer = gross ⇒ exactly
 * the refund amount), so the shop, not the platform, funds the refund.
 */

export type RefundState =
  | "failed"
  | "released"
  | "reserved"
  | "submitted"
  | "succeeded";

/** An operation holds a reservation exactly while it is in one of these. */
const HOLDING: readonly RefundState[] = ["reserved", "submitted"];

/** For each target state, the states it may be reached from (0019's trigger). */
const ALLOWED_FROM: Record<RefundState, readonly RefundState[]> = {
  failed: ["reserved", "submitted", "succeeded", "released"],
  released: ["reserved"],
  reserved: [],
  submitted: ["reserved", "released"],
  succeeded: ["reserved", "submitted", "released"],
};

/** D9 (DECISIONS.md): the platform fee is non-refundable on Cloudflare. */
export const REFUND_APPLICATION_FEE = false;

/** Bounded retries of an optimistic settlement transition. */
const MAX_ATTEMPTS = 5;

/**
 * Bounded retries of the optimistic RESERVATION. Losing the version race means
 * another refund of the same order reserved or settled in between (each bumps
 * refund_version), so every loss is someone else's progress and the bound only
 * has to exceed what one order's concurrent refunds can produce — two version
 * bumps per competing refund. A request that still loses answers 409 and the
 * admin retries; it never over-reserves.
 */
const RESERVE_ATTEMPTS = 25;

/** Stripe's refund status → the operation state it proves. */
export function refundTargetState(stripeStatus: string): RefundState {
  if (stripeStatus === "succeeded") {
    return "succeeded";
  }

  if (stripeStatus === "failed" || stripeStatus === "canceled") {
    return "failed";
  }

  // pending, requires_action — and anything Stripe adds later: Stripe has it,
  // the outcome is not known yet.
  return "submitted";
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

// ── The order's status after a refund ─────────────────────────────────────
// Evaluated AFTER the money columns moved, so it reads the new totals.
// Firebase semantics (connectParams.refundStateAfter): fully refunded ⇒
// 'refunded'; a partial refund of a 'paid' order ⇒ 'partially_refunded'.
// Fulfilment statuses a partial refund meets are left alone — the money
// columns carry the refund, and CP2-B's dispatch states are not the refund's to
// overwrite. A refund that fails AFTER succeeding walks the status back.
const STATUS_AFTER_REFUND_SQL = `CASE
    WHEN charged_minor > 0 AND refund_succeeded_minor >= charged_minor
      AND status NOT IN ('refunded', 'cancelled') THEN 'refunded'
    WHEN refund_succeeded_minor > 0 AND refund_succeeded_minor < charged_minor
      AND status IN ('paid', 'refunded') THEN 'partially_refunded'
    WHEN refund_succeeded_minor = 0
      AND status IN ('partially_refunded', 'refunded') THEN 'paid'
    ELSE status
  END`;

/**
 * The statements that apply one operation transition to its order, in batch
 * order: the money; then — if the order is now refunded to the charge by THIS
 * transition — the dispatch cancellation, while the status is still the one
 * the return-case guard must see; then the status history and the status.
 */
function orderEffectStatements(
  db: D1Database,
  op: { id: string; orderId: string; tenantId: string; transitionId: string },
  actorUserId: string | null,
  now: number,
): D1PreparedStatement[] {
  const holding = HOLDING.map((state) => `'${state}'`).join(", ");
  const transitioned = `EXISTS (
      SELECT 1 FROM refund_operations
      WHERE id = ?1 AND transition_id = ?2
    )`;
  const delta = (current: string, previous: string) => `(
      SELECT (${current}) - (${previous})
      FROM refund_operations
      WHERE id = ?1 AND transition_id = ?2
    )`;
  const reservedDelta = delta(
    `CASE WHEN state IN (${holding}) THEN amount_minor ELSE 0 END`,
    `CASE WHEN prev_state IN (${holding}) THEN amount_minor ELSE 0 END`,
  );
  const succeededDelta = delta(
    "CASE WHEN state = 'succeeded' THEN amount_minor ELSE 0 END",
    "CASE WHEN prev_state = 'succeeded' THEN amount_minor ELSE 0 END",
  );

  return [
    db
      .prepare(
        `UPDATE orders
         SET refund_reserved_minor = refund_reserved_minor + ${reservedDelta},
             refund_succeeded_minor = refund_succeeded_minor + ${succeededDelta},
             refunded_total_minor = refunded_total_minor + ${succeededDelta},
             refund_version = refund_version + 1,
             updated_at = MAX(updated_at, ?4)
         WHERE order_id = ?3 AND ${transitioned}`,
      )
      .bind(op.id, op.transitionId, op.orderId, now),
    // A full refund stops production — decided in THIS batch, from the money
    // the UPDATE above just wrote (refund-dispatch-stop.ts).
    ...fullRefundStopStatements(db, {
      nowMs: now,
      operationId: op.id,
      orderId: op.orderId,
      tenantId: op.tenantId,
      transitionId: op.transitionId,
    }),
    // The status history row is written BEFORE the status moves, so
    // `from_status` is the old one; both are no-ops when nothing changes.
    db
      .prepare(
        `INSERT INTO order_status_history (
          history_id, order_id, tenant_id, from_status, to_status,
          actor_user_id, reason, created_at
        )
        SELECT ?5, order_id, tenant_id, status, ${STATUS_AFTER_REFUND_SQL},
               ?6, 'refund', ?4
        FROM orders
        WHERE order_id = ?3 AND ${transitioned}
          AND status <> ${STATUS_AFTER_REFUND_SQL}`,
      )
      .bind(
        op.id,
        op.transitionId,
        op.orderId,
        now,
        crypto.randomUUID(),
        actorUserId,
      ),
    db
      .prepare(
        `UPDATE orders
         SET status = ${STATUS_AFTER_REFUND_SQL}
         WHERE order_id = ?3 AND ${transitioned}
           AND status <> ${STATUS_AFTER_REFUND_SQL}`,
      )
      .bind(op.id, op.transitionId, op.orderId),
    // CP5-WE: the buyer's refund notice, ONLY when THIS transition is the one
    // that made the operation 'succeeded' (a reservation, a submission or a
    // failure writes nothing). After the money moved, so `full` reads the new
    // totals. Ids and a flag only. DO NOTHING on any conflict: a mail row can
    // never abort the batch that moves money.
    db
      .prepare(
        `INSERT INTO outbox_events (
           outbox_id, tenant_id, event_type, aggregate_type, aggregate_id,
           dedupe_key, payload_json, status, next_attempt_at, created_at, updated_at
         )
         SELECT 'email-refund-notice:' || r.id, o.tenant_id, 'email', 'order', o.order_id,
                'email:refund_notice:' || r.id,
                json_object('kind', 'refund_notice', 'orderId', o.order_id, 'operationId', r.id,
                            'full', json(CASE WHEN o.charged_minor > 0
                                               AND o.refund_succeeded_minor >= o.charged_minor
                                              THEN 'true' ELSE 'false' END)),
                'pending', ?4, ?4, ?4
         FROM refund_operations AS r
         JOIN orders AS o ON o.order_id = r.order_id AND o.tenant_id = r.tenant_id
         WHERE r.id = ?1 AND r.transition_id = ?2 AND o.order_id = ?3
           AND r.state = 'succeeded' AND r.prev_state IS NOT 'succeeded'
         ON CONFLICT DO NOTHING`,
      )
      .bind(op.id, op.transitionId, op.orderId, now),
  ];
}

interface OperationRow {
  amount_minor: number;
  created_by: string | null;
  id: string;
  order_id: string;
  state: RefundState;
  stripe_refund_id: string | null;
  tenant_id: string;
}

const OPERATION_COLUMNS =
  "id, tenant_id, order_id, amount_minor, state, stripe_refund_id, created_by";

/**
 * Moves one operation to `to`, applying its money effect in the same batch.
 * Returns true when THIS call performed the transition.
 */
async function transitionOperation(
  db: D1Database,
  op: OperationRow,
  to: RefundState,
  stripeRefundId: string | null,
  now: number,
  extra: D1PreparedStatement[] = [],
): Promise<boolean> {
  const allowed = ALLOWED_FROM[to];
  if (!allowed.includes(op.state)) {
    return false;
  }

  const transitionId = crypto.randomUUID();
  const placeholders = allowed.map(() => "?").join(", ");
  const results = await db.batch([
    db
      .prepare(
        `UPDATE refund_operations
         SET prev_state = state,
             state = ?,
             transition_id = ?,
             stripe_refund_id = COALESCE(stripe_refund_id, ?),
             updated_at = MAX(updated_at, ?)
         WHERE id = ? AND state IN (${placeholders})`,
      )
      .bind(to, transitionId, stripeRefundId, iso(now), op.id, ...allowed),
    ...orderEffectStatements(
      db,
      { id: op.id, orderId: op.order_id, tenantId: op.tenant_id, transitionId },
      op.created_by,
      now,
    ),
    ...extra,
  ]);

  return results[0]?.meta.changes === 1;
}

// ── Facts ────────────────────────────────────────────────────────────────

export interface RefundFact {
  amount: number;
  /** metadata.refund_operation_id, when this worker created the refund. */
  operationId: string | null;
  paymentIntentId: string | null;
  status: string;
  stripeRefundId: string;
}

export type RefundFactResult =
  | { result: "amount_mismatch"; tenantId: string }
  | { result: "applied"; tenantId: string }
  | { result: "unchanged"; tenantId: string }
  | { result: "unknown_order" };

/** A Stripe Refund object (event payload or API response) as a fact, or null. */
export function refundFactFrom(refund: unknown): RefundFact | null {
  if (typeof refund !== "object" || refund === null) {
    return null;
  }

  const candidate = refund as Record<string, unknown>;
  const id = candidate.id;
  const amount = candidate.amount;
  const status = candidate.status;
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_]{3,255}$/.test(id) ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    typeof status !== "string"
  ) {
    return null;
  }

  const rawIntent = candidate.payment_intent;
  const intent =
    typeof rawIntent === "string"
      ? rawIntent
      : typeof rawIntent === "object" && rawIntent !== null
        ? (rawIntent as { id?: unknown }).id
        : null;
  const metadata =
    typeof candidate.metadata === "object" && candidate.metadata !== null
      ? (candidate.metadata as Record<string, unknown>)
      : {};
  const operationId = metadata.refund_operation_id;

  return {
    amount,
    operationId:
      typeof operationId === "string" && operationId.length > 0
        ? operationId
        : null,
    paymentIntentId: typeof intent === "string" ? intent : null,
    status,
    stripeRefundId: id,
  };
}

async function findOperationForFact(
  db: D1Database,
  fact: RefundFact,
): Promise<OperationRow | null> {
  const byRefund = await db
    .prepare(
      `SELECT ${OPERATION_COLUMNS} FROM refund_operations
       WHERE stripe_refund_id = ? LIMIT 1`,
    )
    .bind(fact.stripeRefundId)
    .first<OperationRow>();
  if (byRefund !== null || fact.operationId === null) {
    return byRefund;
  }

  // Our own request whose refund id is not recorded yet (the API response was
  // lost, or the webhook beat it). An operation already bound to a DIFFERENT
  // refund id is not this refund: that one is a separate refund and is born as
  // its own operation below.
  return db
    .prepare(
      `SELECT ${OPERATION_COLUMNS} FROM refund_operations
       WHERE id = ? AND stripe_refund_id IS NULL LIMIT 1`,
    )
    .bind(fact.operationId)
    .first<OperationRow>();
}

/**
 * Applies one Stripe fact about one refund. Idempotent: the same fact twice,
 * or two facts racing, move the money at most once.
 */
export async function applyRefundFact(
  db: D1Database,
  fact: RefundFact,
  now: number,
): Promise<RefundFactResult> {
  const target = refundTargetState(fact.status);
  let lastTenant: string | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const op = await findOperationForFact(db, fact);

    if (op !== null) {
      lastTenant = op.tenant_id;
      if (op.amount_minor !== fact.amount) {
        // Stripe was asked for exactly op.amount_minor under an idempotency
        // key, so a different amount means something outside this design
        // happened. Money is not moved on a guess; a human reconciles.
        await raiseAlertStatement(
          db,
          {
            kind: "refund_unsettled_30m",
            message: `refund operation ${op.id}: Stripe refund ${fact.stripeRefundId} reports a different amount`,
            resourceId: op.id,
            resourceType: "refund_operation",
            severity: "critical",
            tenantId: op.tenant_id,
          },
          now,
        ).run();
        return { result: "amount_mismatch", tenantId: op.tenant_id };
      }

      if (op.state === target || !ALLOWED_FROM[target].includes(op.state)) {
        return { result: "unchanged", tenantId: op.tenant_id };
      }

      const lateFailure = op.state === "succeeded" && target === "failed";
      const applied = await transitionOperation(
        db,
        op,
        target,
        fact.stripeRefundId,
        now,
        lateFailure
          ? [
              raiseAlertStatement(
                db,
                {
                  kind: "refund_failed_after_success",
                  message: `refund operation ${op.id}: Stripe refund ${fact.stripeRefundId} failed after succeeding; check the transfer reversal`,
                  resourceId: op.id,
                  resourceType: "refund_operation",
                  severity: "critical",
                  tenantId: op.tenant_id,
                },
                now,
              ),
            ]
          : [],
      );
      if (applied) {
        return { result: "applied", tenantId: op.tenant_id };
      }

      // Another fact moved it first; re-read and decide again.
      continue;
    }

    // A refund this worker never asked for: the Stripe dashboard, or another
    // integration on the same account. Found by its intent; born as an
    // operation carrying the fact's state.
    if (fact.paymentIntentId === null) {
      return { result: "unknown_order" };
    }

    const order = await db
      .prepare(
        "SELECT order_id, tenant_id FROM orders WHERE payment_intent_id = ? LIMIT 1",
      )
      .bind(fact.paymentIntentId)
      .first<{ order_id: string; tenant_id: string }>();
    if (order === null) {
      return { result: "unknown_order" };
    }

    const operationId = crypto.randomUUID();
    const transitionId = crypto.randomUUID();
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO refund_operations (
              id, tenant_id, order_id, amount_minor, state, prev_state,
              stripe_refund_id, origin, reason, created_by, transition_id,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'stripe', 'stripe_dashboard', NULL, ?, ?, ?)`,
          )
          .bind(
            operationId,
            order.tenant_id,
            order.order_id,
            fact.amount,
            target,
            fact.stripeRefundId,
            transitionId,
            iso(now),
            iso(now),
          ),
        ...orderEffectStatements(
          db,
          {
            id: operationId,
            orderId: order.order_id,
            tenantId: order.tenant_id,
            transitionId,
          },
          null,
          now,
        ),
      ]);
      return { result: "applied", tenantId: order.tenant_id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("refund_operations.stripe_refund_id")) {
        throw error;
      }
      // A concurrent fact created it first: loop and apply as a transition.
    }
  }

  // Every attempt lost a race to another fact about the same refund. Whatever
  // won has already moved it; nothing is lost by stopping here.
  return lastTenant === null
    ? { result: "unknown_order" }
    : { result: "unchanged", tenantId: lastTenant };
}

// ── The admin request ────────────────────────────────────────────────────

export interface RefundRequestInput {
  amountMinor: number;
  reason: string;
}

/** Strict body: exactly `{ amountMinor, reason }`. */
export function parseRefundRequestInput(body: unknown): RefundRequestInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("amountMinor") || !keys.includes("reason")) {
    return null;
  }

  const { amountMinor, reason } = body as Record<string, unknown>;
  if (
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    typeof reason !== "string"
  ) {
    return null;
  }

  const trimmed = reason.trim();
  if (trimmed.length < 1 || trimmed.length > 500 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }

  return { amountMinor, reason: trimmed };
}

export interface RefundOperationView {
  amountMinor: number;
  refundId: string;
  state: RefundState;
}

export type RequestRefundResult =
  /** Stripe answered; the operation is submitted, succeeded or failed. */
  | { refund: RefundOperationView; status: "created" }
  /** Stripe's outcome is unknown; the reservation holds until reconciled. */
  | { refund: RefundOperationView; status: "pending" }
  | { status: "not_allowed" }
  | { status: "not_found" };

interface OrderRefundRow {
  charged_minor: number;
  currency: string;
  dispute_status: string | null;
  payment_intent_id: string;
  refund_reserved_minor: number;
  refund_succeeded_minor: number;
  refund_version: number;
}

/**
 * `POST /v1/admin/orders/:orderId/refunds` — reserve, then ask Stripe.
 *
 * `options.clientKey` (CP2-E): the admin's Idempotency-Key, stored on the
 * operation IN the reservation batch; `refund_operations_client_key_idx`
 * (UNIQUE per tenant) then makes a second reservation under the same key
 * impossible — the batch aborts and the caller replays the first operation
 * (src/routes/money-orders.ts).
 */
export async function requestRefund(
  db: D1Database,
  gateway: StripeMoneyGateway,
  principal: TenantAdminPrincipal,
  orderId: string,
  input: RefundRequestInput,
  now: number,
  options: { clientKey?: string } = {},
): Promise<RequestRefundResult> {
  const operationId = crypto.randomUUID();
  let reserved = false;

  for (let attempt = 0; attempt < RESERVE_ATTEMPTS && !reserved; attempt += 1) {
    const order = await db
      .prepare(
        `SELECT charged_minor, refund_succeeded_minor, refund_reserved_minor,
                refund_version, dispute_status, payment_intent_id, currency
         FROM orders
         WHERE order_id = ? AND tenant_id = ?
         LIMIT 1`,
      )
      .bind(orderId, principal.tenantId)
      .first<OrderRefundRow>();
    if (order === null) {
      return { status: "not_found" };
    }

    // A disputed charge cannot be refunded (Stripe refuses it, and the buyer's
    // money is already moving through the dispute).
    if (disputeBlocksRefund(order.dispute_status)) {
      return { status: "not_allowed" };
    }

    const remaining =
      order.charged_minor -
      order.refund_succeeded_minor -
      order.refund_reserved_minor;
    if (input.amountMinor > remaining) {
      return { status: "not_allowed" };
    }

    const onlyIfReserved = `EXISTS (
      SELECT 1 FROM orders WHERE order_id = ? AND last_refund_op_id = ?
    )`;
    const results = await db.batch([
      db
        .prepare(
          `UPDATE orders
           SET refund_reserved_minor = refund_reserved_minor + ?,
               refund_version = refund_version + 1,
               last_refund_op_id = ?,
               updated_at = MAX(updated_at, ?)
           WHERE order_id = ?
             AND tenant_id = ?
             AND refund_version = ?
             AND charged_minor - refund_succeeded_minor - refund_reserved_minor >= ?`,
        )
        .bind(
          input.amountMinor,
          operationId,
          now,
          orderId,
          principal.tenantId,
          order.refund_version,
          input.amountMinor,
        ),
      db
        .prepare(
          `INSERT INTO refund_operations (
            id, tenant_id, order_id, amount_minor, state, origin, reason,
            created_by, created_at, updated_at, client_key
          )
          SELECT ?, ?, ?, ?, 'reserved', 'admin', ?, ?, ?, ?, ?
          WHERE ${onlyIfReserved}`,
        )
        .bind(
          operationId,
          principal.tenantId,
          orderId,
          input.amountMinor,
          input.reason,
          principal.userId,
          iso(now),
          iso(now),
          options.clientKey ?? null,
          orderId,
          operationId,
        ),
      db
        .prepare(
          `INSERT INTO audit_events (
            event_id, tenant_id, actor_user_id, action, resource_type,
            resource_id, request_id, metadata_json, created_at
          )
          SELECT ?, ?, ?, 'order.refund.requested', 'order', ?, ?, ?, ?
          WHERE ${onlyIfReserved}`,
        )
        .bind(
          crypto.randomUUID(),
          principal.tenantId,
          principal.userId,
          orderId,
          operationId,
          auditMetadataJson(principal, {
            amountMinor: input.amountMinor,
            refundId: operationId,
          }),
          now,
          orderId,
          operationId,
        ),
    ]);

    reserved = results[0]?.meta.changes === 1;
    if (!reserved) {
      continue;
    }

    return submitReservedRefund(db, gateway, {
      amountMinor: input.amountMinor,
      operationId,
      orderId,
      paymentIntentId: order.payment_intent_id,
      tenantId: principal.tenantId,
      userId: principal.userId,
    }, now);
  }

  // Every attempt lost the version race to other refunds of the same order.
  return { status: "not_allowed" };
}

async function submitReservedRefund(
  db: D1Database,
  gateway: StripeMoneyGateway,
  op: {
    amountMinor: number;
    operationId: string;
    orderId: string;
    paymentIntentId: string;
    tenantId: string;
    userId: string;
  },
  now: number,
): Promise<RequestRefundResult> {
  const reservedRow: OperationRow = {
    amount_minor: op.amountMinor,
    created_by: op.userId,
    id: op.operationId,
    order_id: op.orderId,
    state: "reserved",
    stripe_refund_id: null,
    tenant_id: op.tenantId,
  };

  let refund: RefundView;
  try {
    refund = await gateway.createRefund({
      amount: op.amountMinor,
      // THE idempotency key: one operation can never become two refunds, and
      // a retry after a lost response returns the refund the first call made.
      idempotencyKey: op.operationId,
      // Join keys only.
      metadata: {
        order_id: op.orderId,
        refund_operation_id: op.operationId,
        tenant_id: op.tenantId,
      },
      paymentIntentId: op.paymentIntentId,
      refundApplicationFee: REFUND_APPLICATION_FEE,
      reverseTransfer: true,
    });
  } catch (error) {
    if (error instanceof StripeGatewayError && error.rejected) {
      // Stripe answered and refused: nothing was created, so the reservation
      // is released now.
      await transitionOperation(db, reservedRow, "failed", null, now);
      return {
        refund: {
          amountMinor: op.amountMinor,
          refundId: op.operationId,
          state: "failed",
        },
        status: "created",
      };
    }

    // Unknown outcome (network, timeout, 5xx). The reservation HOLDS: the
    // refund may exist at Stripe. A webhook carrying
    // metadata.refund_operation_id, or the reconciliation cron listing the
    // intent's refunds, settles it; if Stripe never got it, reconciliation
    // releases it after 30 minutes.
    if (!(error instanceof StripeGatewayError)) {
      console.error(
        JSON.stringify({
          message: "refund gateway failed with an unexpected error",
          refundId: op.operationId,
        }),
      );
    }

    return {
      refund: {
        amountMinor: op.amountMinor,
        refundId: op.operationId,
        state: "reserved",
      },
      status: "pending",
    };
  }

  const fact = refundFactFrom(refund);
  if (fact !== null) {
    await applyRefundFact(
      db,
      // The operation id is authoritative for the response we just received,
      // whatever the metadata echoes.
      { ...fact, operationId: op.operationId },
      now,
    );
  }

  const current = await db
    .prepare("SELECT state FROM refund_operations WHERE id = ? LIMIT 1")
    .bind(op.operationId)
    .first<{ state: RefundState }>();

  return {
    refund: {
      amountMinor: op.amountMinor,
      refundId: op.operationId,
      state: current?.state ?? "reserved",
    },
    status: "created",
  };
}

/**
 * Releases a reservation Stripe never received. Used by reconciliation only,
 * after the operation has sat 'reserved' for over 30 minutes and Stripe's own
 * list of the intent's refunds shows nothing carrying its id.
 */
export async function releaseReservation(
  db: D1Database,
  operationId: string,
  now: number,
): Promise<boolean> {
  const op = await db
    .prepare(`SELECT ${OPERATION_COLUMNS} FROM refund_operations WHERE id = ? LIMIT 1`)
    .bind(operationId)
    .first<OperationRow>();
  if (op === null || op.state !== "reserved") {
    return false;
  }

  return transitionOperation(db, op, "released", null, now);
}
