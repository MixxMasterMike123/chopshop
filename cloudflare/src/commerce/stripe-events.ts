import { holdDispatchStatement, releaseDispatchHolds } from "./dispatch-hold";
import { raiseAlertStatement } from "./money-alerts";
import type { HandleWebhookEventResult } from "./payment-events";
import {
  REASON_ALREADY_APPLIED,
  REASON_DEFERRED_UNTIL_ORDER,
  REASON_MALFORMED_OBJECT,
  REASON_STALE_EVENT,
  REASON_REFUND_AMOUNT_MISMATCH,
  REASON_UNHANDLED_TYPE,
  REASON_UNKNOWN_ACCOUNT,
  REASON_UNKNOWN_INTENT,
  REASON_UNKNOWN_ORDER,
  recordEventStatement,
  recordOnly,
  isDuplicateDelivery,
} from "./payment-events";
import type { PayoutFacts } from "./payouts";
import {
  derivePayoutState,
  isDisputeClosed,
  isDisputeFavourable,
  PAYOUT_FACT_COLUMNS,
} from "./payouts";
import type { RefundFact } from "./refunds";
import { applyRefundFact, refundFactFrom } from "./refunds";
import type { VerifiedStripeEvent } from "./stripe-client";

/**
 * Every verified Stripe event other than `payment_intent.succeeded` (which is
 * webhook.ts's order path), dispatched by `event.type`.
 *
 * ── THE RULES ────────────────────────────────────────────────────────────────
 *  - D1 ONLY. No handler here calls Stripe. The webhook route is not given the
 *    gateway (and must stay boringly fast and correct): an effect that needs a
 *    Stripe call — a dispute's transfer reversal or re-transfer — is RECORDED
 *    as a pending recovery state on the order, in the same batch as the fact,
 *    and performed by the reconciliation cron (crons.ts) with idempotency keys
 *    keyed on the dispute id. That is the outbox discipline of PLAN §2.2
 *    applied to the one money effect the platform initiates on its own.
 *  - Every event is idempotent through the `payment_events` ledger (keyed by
 *    event id, checked by the caller before dispatch). Effects several events
 *    can carry — a refund — are additionally idempotent on their own key.
 *  - 200 for everything understood, including refusals and unknown types; a
 *    D1 fault throws so Stripe retries.
 *
 * ── THE MATRIX ───────────────────────────────────────────────────────────────
 *   payment_intent.payment_failed  checkouts.payment_intent_status ← status
 *   payment_intent.canceled        checkouts.payment_intent_status ← canceled
 *   refund.created/updated/failed  applyRefundFact (deduped by refund id)
 *   charge.refunded                orders.stripe_amount_refunded_minor ↑ and
 *                                  any embedded refunds applied as facts
 *   charge.dispute.created         order: dispute recorded, payout blocked,
 *                                  recovery 'reversal_pending' (Firebase
 *                                  reverseDisputeOnCreated default = true)
 *   charge.dispute.updated         status/amount refreshed
 *   charge.dispute.closed          won/warning_closed/prevented: a reversal
 *                                  already made is queued back
 *                                  ('retransfer_pending'); lost: reversed if
 *                                  not yet ('reversal_pending')
 *   account.updated                tenants.stripe_* capability flags, applied
 *                                  only from an event NEWER than the last one
 *                                  applied (Stripe does not deliver in order)
 *   anything else                  recorded 'ignored', logged by type only
 *
 * ── EVENTS THAT ARRIVE BEFORE THEIR ORDER ────────────────────────────────────
 * A refund or dispute can be processed while the payment_intent.succeeded that
 * creates the order is still being retried. If a CHECKOUT here owns the intent,
 * the normalised fact is DEFERRED (0026 deferred_payment_events, same batch as
 * the ledger row) and replayed through the same appliers as soon as the order
 * exists: by the order webhook right after its batch, by this handler if the
 * order appeared meanwhile, and by every reconciliation run. An intent no
 * checkout owns is another integration's and stays 'ignored'.
 */

/**
 * Firebase `settings/platform.reverseDisputeOnCreated`, default true: claw the
 * disputed principal back from the shop as soon as a dispute opens, because the
 * platform's balance is debited for the whole charge at that moment
 * (destination charge, platform = merchant of record).
 */
export const REVERSE_DISPUTE_ON_CREATED = true;

const MAX_ATTEMPTS = 5;

export async function handleStripeEvent(
  db: D1Database,
  event: VerifiedStripeEvent,
  now: number,
): Promise<HandleWebhookEventResult> {
  switch (event.type) {
    case "payment_intent.payment_failed":
    case "payment_intent.canceled":
      return handleIntentStatus(db, event, now);
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
      return handleRefundEvent(db, event, now);
    case "charge.refunded":
      return handleChargeRefunded(db, event, now);
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      return handleDisputeEvent(db, event, now);
    case "account.updated":
      return handleAccountUpdated(db, event, now);
    default:
      // Acknowledged and recorded, never refused. The type is the only thing
      // logged: an event body carries buyer data.
      console.info(
        JSON.stringify({
          eventType: event.type,
          message: "stripe event type not handled",
        }),
      );
      return recordOnly(
        db,
        event,
        null,
        null,
        "ignored",
        REASON_UNHANDLED_TYPE,
        now,
      );
  }
}

function objectOf(event: VerifiedStripeEvent): Record<string, unknown> | null {
  const object = event.data.object;
  return typeof object === "object" && object !== null && !Array.isArray(object)
    ? (object as Record<string, unknown>)
    : null;
}

/** A Stripe id (string or expanded object) of the conventional shape. */
function stripeId(value: unknown): string | null {
  const id =
    typeof value === "object" && value !== null
      ? (value as { id?: unknown }).id
      : value;
  return typeof id === "string" && /^[A-Za-z0-9_]{3,255}$/.test(id) ? id : null;
}

function statusShape(value: unknown): string | null {
  return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : null;
}

/**
 * Runs a batch whose effects are guarded, then records the ledger row. The
 * ledger row rides in the same batch, so a duplicate delivery racing this one
 * fails the whole batch on the event-id primary key and is answered as a
 * replay.
 */
async function commitWithLedger(
  db: D1Database,
  event: VerifiedStripeEvent,
  effects: D1PreparedStatement[],
  tenantId: string | null,
  objectId: string | null,
  now: number,
): Promise<HandleWebhookEventResult> {
  try {
    await db.batch([
      ...effects,
      recordEventStatement(db, event, tenantId, objectId, "processed", null, now),
    ]);
  } catch (error) {
    if (!isDuplicateDelivery(error)) {
      throw error;
    }

    return { outcome: "processed", replayed: true };
  }

  return { outcome: "processed", replayed: false };
}

// ── payment_intent.payment_failed / payment_intent.canceled ──────────────────

/**
 * Records the intent's new state on its checkout. That is the whole effect:
 * the retention sweep reads it (a canceled intent's snapshot may be purged 7
 * days later; `requires_payment_method` is NOT terminal and keeps the clock
 * running from this moment). Firebase additionally marked the checkout
 * 'failed' to keep abandoned-cart reminders away; there are no reminders here.
 */
async function handleIntentStatus(
  db: D1Database,
  event: VerifiedStripeEvent,
  now: number,
): Promise<HandleWebhookEventResult> {
  const object = objectOf(event);
  const intentId = stripeId(object?.id);
  if (object === null || intentId === null) {
    return recordOnly(db, event, null, null, "rejected", REASON_MALFORMED_OBJECT, now);
  }

  const status =
    event.type === "payment_intent.canceled"
      ? "canceled"
      : (statusShape(object.status) ?? "requires_payment_method");

  const checkout = await db
    .prepare(
      "SELECT checkout_id, tenant_id FROM checkouts WHERE payment_intent_id = ? LIMIT 1",
    )
    .bind(intentId)
    .first<{ checkout_id: string; tenant_id: string }>();
  if (checkout === null) {
    return recordOnly(db, event, null, intentId, "ignored", REASON_UNKNOWN_INTENT, now);
  }

  // Never regress a terminal state: a late payment_failed after the intent
  // succeeded or was canceled changes nothing (0019 also refuses it).
  return commitWithLedger(
    db,
    event,
    [
      db
        .prepare(
          `UPDATE checkouts
           SET payment_intent_status = ?,
               payment_intent_status_at = ?,
               updated_at = MAX(updated_at, ?)
           WHERE checkout_id = ?
             AND (payment_intent_status IS NULL
                  OR payment_intent_status NOT IN ('succeeded', 'canceled'))`,
        )
        .bind(status, now, now, checkout.checkout_id),
    ],
    checkout.tenant_id,
    intentId,
    now,
  );
}

// ── refunds ─────────────────────────────────────────────────────────────────

async function recordRefundOutcome(
  db: D1Database,
  event: VerifiedStripeEvent,
  results: Awaited<ReturnType<typeof applyRefundFact>>[],
  objectId: string,
  now: number,
): Promise<HandleWebhookEventResult> {
  const known = results.find((r) => r.result !== "unknown_order");
  const tenantId = known !== undefined && "tenantId" in known ? known.tenantId : null;

  if (known === undefined) {
    // Not an order of ours: another integration on a shared account.
    return recordOnly(db, event, null, objectId, "ignored", REASON_UNKNOWN_INTENT, now);
  }

  if (results.some((r) => r.result === "amount_mismatch")) {
    return recordOnly(db, event, tenantId, objectId, "rejected", REASON_REFUND_AMOUNT_MISMATCH, now);
  }

  const applied = results.some((r) => r.result === "applied");
  return recordOnly(
    db,
    event,
    tenantId,
    objectId,
    "processed",
    applied ? null : REASON_ALREADY_APPLIED,
    now,
  );
}

/**
 * refund.created / refund.updated / refund.failed — one Refund, one fact. The
 * effect is applied through the refund state machine (idempotent by refund
 * id), then the ledger row is written; a crash between the two is healed by
 * the redelivery, which applies nothing and records the row.
 */
async function handleRefundEvent(
  db: D1Database,
  event: VerifiedStripeEvent,
  now: number,
): Promise<HandleWebhookEventResult> {
  const fact = refundFactFrom(event.data.object);
  if (fact === null) {
    return recordOnly(db, event, null, null, "rejected", REASON_MALFORMED_OBJECT, now);
  }

  const result = await applyRefundFact(db, fact, now);
  if (result.result !== "unknown_order" && fact.paymentIntentId !== null) {
    // A settled refund may be the one that explains a `charge.refunded`
    // figure a hold was waiting on.
    await releaseDispatchHolds(db, { now, paymentIntentId: fact.paymentIntentId });
  }

  if (result.result === "unknown_order" && fact.paymentIntentId !== null) {
    const deferred = await deferUntilOrder(
      db,
      event,
      fact.paymentIntentId,
      { fact, kind: "refund" },
      fact.stripeRefundId,
      now,
    );
    if (deferred !== null) {
      return deferred;
    }
  }

  return recordRefundOutcome(db, event, [result], fact.stripeRefundId, now);
}

/**
 * charge.refunded — a Charge. Its `amount_refunded` (cumulative, Stripe's
 * figure) is recorded on the order as the highest value seen; when it exceeds
 * what this worker has settled, the reconciliation cron lists the intent's
 * refunds from Stripe and settles them. Refunds the payload happens to embed
 * (older API versions, or an expanded `refunds` list) are applied directly.
 */
async function handleChargeRefunded(
  db: D1Database,
  event: VerifiedStripeEvent,
  now: number,
): Promise<HandleWebhookEventResult> {
  const object = objectOf(event);
  const chargeId = stripeId(object?.id);
  const intentId = stripeId(object?.payment_intent);
  const amountRefunded = object?.amount_refunded;
  if (
    object === null ||
    chargeId === null ||
    intentId === null ||
    typeof amountRefunded !== "number" ||
    !Number.isSafeInteger(amountRefunded) ||
    amountRefunded < 0
  ) {
    return recordOnly(db, event, null, chargeId, "rejected", REASON_MALFORMED_OBJECT, now);
  }

  const embedded = object.refunds;
  const refundObjects =
    typeof embedded === "object" &&
    embedded !== null &&
    Array.isArray((embedded as { data?: unknown }).data)
      ? ((embedded as { data: unknown[] }).data)
      : [];
  const fact: ChargeRefundedFact = {
    amountRefunded,
    chargeId,
    paymentIntentId: intentId,
    refunds: refundObjects
      .map((refund) => refundFactFrom(refund))
      .filter((refund): refund is RefundFact => refund !== null)
      .map((refund) => ({ ...refund, paymentIntentId: refund.paymentIntentId ?? intentId })),
  };

  const order = await orderForIntent(db, intentId);
  if (order === null) {
    const deferred = await deferUntilOrder(
      db,
      event,
      intentId,
      { fact, kind: "charge_refunded" },
      chargeId,
      now,
    );
    return deferred ?? recordOnly(db, event, null, chargeId, "ignored", REASON_UNKNOWN_INTENT, now);
  }

  for (const refund of fact.refunds) {
    await applyRefundFact(db, refund, now);
  }

  // Stripe says money went back that no refund event has explained yet: the
  // order's print job is held (same batch) until reconciliation lists and
  // settles those refunds — or released at once if they already are.
  const outcome = await commitWithLedger(
    db,
    event,
    [
      chargeRefundedStatement(db, fact, order.order_id, now),
      holdDispatchStatement(db, { now, paymentIntentId: intentId }),
    ],
    order.tenant_id,
    chargeId,
    now,
  );
  await releaseDispatchHolds(db, { now, paymentIntentId: intentId });
  return outcome;
}

interface ChargeRefundedFact {
  amountRefunded: number;
  chargeId: string;
  paymentIntentId: string;
  refunds: RefundFact[];
}

/** Stripe's cumulative refunded figure onto the order: the highest seen. */
function chargeRefundedStatement(
  db: D1Database,
  fact: ChargeRefundedFact,
  orderId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE orders
       SET stripe_amount_refunded_minor = MAX(stripe_amount_refunded_minor, ?),
           stripe_charge_id = COALESCE(stripe_charge_id, ?),
           updated_at = MAX(updated_at, ?)
       WHERE order_id = ?`,
    )
    .bind(fact.amountRefunded, fact.chargeId, now, orderId);
}

async function orderForIntent(
  db: D1Database,
  paymentIntentId: string,
): Promise<{ order_id: string; tenant_id: string } | null> {
  return db
    .prepare("SELECT order_id, tenant_id FROM orders WHERE payment_intent_id = ? LIMIT 1")
    .bind(paymentIntentId)
    .first<{ order_id: string; tenant_id: string }>();
}

// ── disputes ────────────────────────────────────────────────────────────────

type Recovery =
  | "no_transfer"
  | "pending_outcome"
  | "recovered"
  | "retransfer_failed"
  | "retransfer_pending"
  | "returned_won"
  | "reversal_pending"
  | "shortfall"
  | "won_no_reversal";

/**
 * The recovery state a dispute status implies, given where recovery is.
 * Firebase rules (functions/src/payment/stripeWebhook.ts:793-917):
 *   created           reverse the transfer now (reverseDisputeOnCreated)
 *   closed WON        re-transfer what was reversed; nothing reversed ⇒ done
 *   closed LOST       reverse if not reversed yet; otherwise final
 * One deliberate difference, flagged in the CP2-A report: Firebase treats
 * `warning_closed` like LOST. An inquiry that closes without a chargeback took
 * no money from anyone, so here it is treated like WON and a reversal made on
 * creation is returned to the shop.
 *
 * `reversal_pending` means "a reversal MAY have been made": the cron may have
 * called Stripe and lost the answer, or crashed before recording it (Codex
 * CP2-A P1). A favourable close therefore never concludes "nothing to return"
 * from it: it becomes `retransfer_pending`, and the cron asks Stripe which
 * reversal exists for this dispute before returning exactly that — or, when
 * Stripe has none, settles on `won_no_reversal` itself. Only the states that
 * PROVE no reversal (never attempted, or Stripe refused it) go straight there.
 */
export function nextRecovery(
  current: Recovery | null,
  status: string,
): Recovery | null {
  if (isDisputeFavourable(status)) {
    if (current === "recovered" || current === "reversal_pending") {
      return "retransfer_pending";
    }

    if (
      current === null ||
      current === "pending_outcome" ||
      current === "no_transfer" ||
      current === "shortfall"
    ) {
      return "won_no_reversal";
    }

    return current;
  }

  if (isDisputeClosed(status)) {
    // Lost.
    return current === null || current === "pending_outcome"
      ? "reversal_pending"
      : current;
  }

  // Open.
  if (current === null) {
    return REVERSE_DISPUTE_ON_CREATED ? "reversal_pending" : "pending_outcome";
  }

  return current;
}

interface DisputeOrderRow extends PayoutFacts {
  dispute_id: string | null;
  order_id: string;
  stripe_payouts_enabled: number;
  tenant_id: string;
}

interface DisputeFact {
  amount: number;
  chargeId: string | null;
  disputeId: string;
  intentId: string | null;
  status: string;
}

type DisputeFactResult =
  | { result: "applied"; tenantId: string }
  | { result: "mismatch"; tenantId: string }
  | { result: "unknown_order" };

/**
 * Applies one dispute fact to its order: status and amount recorded, the
 * recovery state moved per nextRecovery, the payout state recomputed (blocked
 * while open or while the cron still has money to move). Idempotent — the
 * same fact twice lands on the same row values — and guarded on the recovery
 * state it read, so a concurrent cron transition makes the UPDATE a no-op and
 * the fact is re-applied on top of it rather than overwriting it.
 */
async function applyDisputeFact(
  db: D1Database,
  fact: DisputeFact,
  now: number,
): Promise<DisputeFactResult> {
  let tenantId: string | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const order = await db
      .prepare(
        `SELECT o.order_id, o.tenant_id, o.dispute_id,
                ${PAYOUT_FACT_COLUMNS}, t.stripe_payouts_enabled
         FROM orders AS o
         JOIN tenants AS t ON t.tenant_id = o.tenant_id
         WHERE (?1 IS NOT NULL AND o.payment_intent_id = ?1)
            OR (?2 IS NOT NULL AND o.stripe_charge_id = ?2)
         LIMIT 1`,
      )
      .bind(fact.intentId, fact.chargeId)
      .first<DisputeOrderRow>();
    if (order === null) {
      return { result: "unknown_order" };
    }

    tenantId = order.tenant_id;
    if (order.dispute_id !== null && order.dispute_id !== fact.disputeId) {
      // A charge carries one dispute. A different id on the same order is
      // outside this model; a human looks.
      await raiseAlertStatement(
        db,
        {
          kind: "dispute_recovery_failed",
          message: `order ${order.order_id}: dispute ${fact.disputeId} arrived for a charge already disputed as ${order.dispute_id}`,
          resourceId: order.order_id,
          resourceType: "order",
          severity: "critical",
          tenantId: order.tenant_id,
        },
        now,
      ).run();
      return { result: "mismatch", tenantId: order.tenant_id };
    }

    // A closed dispute never reopens: a late event carrying an open status
    // after the close keeps the closed one.
    const status =
      isDisputeClosed(order.dispute_status) && !isDisputeClosed(fact.status)
        ? (order.dispute_status as string)
        : fact.status;
    const currentRecovery = order.dispute_recovery as Recovery | null;
    const recovery = nextRecovery(currentRecovery, status);
    const payoutState = derivePayoutState(
      { ...order, dispute_recovery: recovery, dispute_status: status },
      now,
      order.stripe_payouts_enabled === 1,
    );

    const result = await db
      .prepare(
        `UPDATE orders
         SET dispute_id = COALESCE(dispute_id, ?),
             dispute_status = ?,
             dispute_amount_minor = ?,
             dispute_recovery = ?,
             dispute_updated_at = ?,
             payout_state = CASE WHEN payout_state = 'paid' THEN 'paid' ELSE ? END,
             stripe_charge_id = COALESCE(stripe_charge_id, ?),
             updated_at = MAX(updated_at, ?)
         WHERE order_id = ?
           AND dispute_recovery IS ?`,
      )
      .bind(
        fact.disputeId,
        status,
        fact.amount,
        recovery,
        now,
        payoutState,
        fact.chargeId,
        now,
        order.order_id,
        currentRecovery,
      )
      .run();
    if (result.meta.changes === 1) {
      return { result: "applied", tenantId: order.tenant_id };
    }
  }

  // Lost every race to the cron; what it wrote stands and the next delivery
  // or reconciliation run sees the dispute again.
  return tenantId === null
    ? { result: "unknown_order" }
    : { result: "applied", tenantId };
}

/**
 * charge.dispute.created / updated / closed: the fact is applied (idempotent),
 * then the ledger row is written.
 */
async function handleDisputeEvent(
  db: D1Database,
  event: VerifiedStripeEvent,
  now: number,
): Promise<HandleWebhookEventResult> {
  const object = objectOf(event);
  const disputeId = stripeId(object?.id);
  const status = statusShape(object?.status);
  const amount = object?.amount;
  if (
    object === null ||
    disputeId === null ||
    status === null ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    return recordOnly(db, event, null, disputeId, "rejected", REASON_MALFORMED_OBJECT, now);
  }

  const fact: DisputeFact = {
    amount,
    chargeId: stripeId(object.charge),
    disputeId,
    intentId: stripeId(object.payment_intent),
    status,
  };
  const outcome = await applyDisputeFact(db, fact, now);

  if (outcome.result === "unknown_order") {
    if (fact.intentId !== null) {
      const deferred = await deferUntilOrder(
        db,
        event,
        fact.intentId,
        { fact, kind: "dispute" },
        disputeId,
        now,
      );
      if (deferred !== null) {
        return deferred;
      }
    }

    return recordOnly(db, event, null, disputeId, "ignored", REASON_UNKNOWN_ORDER, now);
  }

  if (outcome.result === "mismatch") {
    return recordOnly(db, event, outcome.tenantId, disputeId, "rejected", REASON_UNKNOWN_ORDER, now);
  }

  return recordOnly(db, event, outcome.tenantId, disputeId, "processed", null, now);
}

// ── deferral until the order exists (0026) ──────────────────────────────────

type DeferredFact =
  | { fact: ChargeRefundedFact; kind: "charge_refunded" }
  | { fact: DisputeFact; kind: "dispute" }
  | { fact: RefundFact; kind: "refund" };

/**
 * Parks a fact whose intent a CHECKOUT here owns but no order yet has, in the
 * same batch as the event's ledger row, then replays at once in case the
 * order committed between this handler's read and its write. Returns null
 * when no checkout owns the intent (the caller records 'ignored').
 *
 * Why the immediate replay closes the race: the order webhook replays AFTER
 * its batch commits, and D1 serialises batches. Either this deferral commits
 * before that replay reads (the replay sees it) or after it (then the order
 * already exists when the replay below reads).
 */
async function deferUntilOrder(
  db: D1Database,
  event: VerifiedStripeEvent,
  paymentIntentId: string,
  deferred: DeferredFact,
  objectId: string,
  now: number,
): Promise<HandleWebhookEventResult | null> {
  const checkout = await db
    .prepare("SELECT tenant_id FROM checkouts WHERE payment_intent_id = ? LIMIT 1")
    .bind(paymentIntentId)
    .first<{ tenant_id: string }>();
  if (checkout === null) {
    return null;
  }

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO deferred_payment_events (
            event_id, tenant_id, payment_intent_id, kind, fact_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO NOTHING`,
        )
        .bind(
          event.id,
          checkout.tenant_id,
          paymentIntentId,
          deferred.kind,
          JSON.stringify(deferred.fact),
          new Date(now).toISOString(),
        ),
      // An order that committed between this handler's read and now must
      // not dispatch before the fact is applied.
      holdDispatchStatement(db, { now, paymentIntentId }),
      recordEventStatement(
        db,
        event,
        checkout.tenant_id,
        objectId,
        "processed",
        REASON_DEFERRED_UNTIL_ORDER,
        now,
      ),
    ]);
  } catch (error) {
    if (!isDuplicateDelivery(error)) {
      throw error;
    }

    return { outcome: "processed", reasonCode: REASON_DEFERRED_UNTIL_ORDER, replayed: true };
  }

  await replayDeferredPaymentEvents(db, paymentIntentId, now);
  return { outcome: "processed", reasonCode: REASON_DEFERRED_UNTIL_ORDER, replayed: false };
}

const MAX_DEFERRED_PER_INTENT = 100;

/**
 * Applies every parked fact for an intent whose order now exists, in the order
 * they were received, through the same idempotent appliers the live events
 * use, and marks each applied. A fact already applied (or applied twice by two
 * racing replays) changes nothing the second time. A failure leaves the row
 * unapplied for the next replay; nothing is lost.
 */
export async function replayDeferredPaymentEvents(
  db: D1Database,
  paymentIntentId: string,
  now: number,
): Promise<{ applied: number; orderId: string | null; released: string[] }> {
  const order = await orderForIntent(db, paymentIntentId);
  if (order === null) {
    return { applied: 0, orderId: null, released: [] };
  }

  const rows = await db
    .prepare(
      `SELECT event_id, kind, fact_json FROM deferred_payment_events
       WHERE payment_intent_id = ? AND applied_at IS NULL
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
    )
    .bind(paymentIntentId, MAX_DEFERRED_PER_INTENT)
    .all<{ event_id: string; fact_json: string; kind: DeferredFact["kind"] }>();

  let applied = 0;
  for (const row of rows.results) {
    const fact = JSON.parse(row.fact_json) as unknown;
    if (row.kind === "refund") {
      await applyRefundFact(db, fact as RefundFact, now);
    } else if (row.kind === "charge_refunded") {
      const charge = fact as ChargeRefundedFact;
      for (const refund of charge.refunds) {
        await applyRefundFact(db, refund, now);
      }
      await chargeRefundedStatement(db, charge, order.order_id, now).run();
    } else {
      await applyDisputeFact(db, fact as DisputeFact, now);
    }

    const marked = await db
      .prepare(
        `UPDATE deferred_payment_events SET applied_at = MAX(?, created_at)
         WHERE event_id = ? AND applied_at IS NULL`,
      )
      .bind(new Date(now).toISOString(), row.event_id)
      .run();
    applied += marked.meta.changes;
  }

  // Everything parked is applied: the order's print job may go — unless a
  // full refund among the facts already superseded it, or refunds Stripe
  // reported are still unexplained (the release re-checks both).
  const released = await releaseDispatchHolds(db, { now, paymentIntentId });
  return { applied, orderId: order.order_id, released };
}

// ── account.updated ─────────────────────────────────────────────────────────

/**
 * Mirrors a connected account's capabilities onto its shop (Firebase
 * connectOnboarding.statusPatch). The shop is found by the account id this
 * worker stored — never by the account's metadata, which is what bound
 * Firebase's 2026-07-06 account to the wrong shop. `charges_enabled` gates the
 * payment route; `payouts_enabled` gates payout eligibility.
 *
 * ORDER (Codex CP2-A P2). Stripe does not deliver in order, and each event
 * carries the WHOLE account as it was at `event.created`. So the flags are
 * applied only from an event strictly newer than the one last applied
 * (`stripe_account_synced_at` holds that event's `created`, in ms); an older
 * one is recorded and changes nothing. Stripe's `created` has one-second
 * resolution: two events in the same second cannot be ordered, so a tie
 * merges FAIL-CLOSED — each flag stays on only if both events say on. A
 * wrongly-off flag costs a delayed sale until the next update; a wrongly-on
 * one would let money flow to an account Stripe restricted.
 */
async function handleAccountUpdated(
  db: D1Database,
  event: VerifiedStripeEvent,
  now: number,
): Promise<HandleWebhookEventResult> {
  const object = objectOf(event);
  const accountId = stripeId(object?.id);
  if (object === null || accountId === null || !accountId.startsWith("acct_")) {
    return recordOnly(db, event, null, accountId, "rejected", REASON_MALFORMED_OBJECT, now);
  }

  // An event from the Connect endpoint names the account it happened on; it
  // must be the account the payload describes.
  if (event.endpoint === "connect" && event.account !== accountId) {
    return recordOnly(db, event, null, accountId, "rejected", REASON_MALFORMED_OBJECT, now);
  }

  const tenant = await db
    .prepare(
      "SELECT tenant_id, stripe_account_synced_at FROM tenants WHERE stripe_account_id = ? LIMIT 1",
    )
    .bind(accountId)
    .first<{ stripe_account_synced_at: number | null; tenant_id: string }>();
  if (tenant === null) {
    return recordOnly(db, event, null, accountId, "ignored", REASON_UNKNOWN_ACCOUNT, now);
  }

  if (
    typeof event.created !== "number" ||
    !Number.isSafeInteger(event.created) ||
    event.created <= 0
  ) {
    return recordOnly(db, event, tenant.tenant_id, accountId, "rejected", REASON_MALFORMED_OBJECT, now);
  }

  const eventAt = event.created * 1_000;
  const flag = (value: unknown) => (value === true ? 1 : 0);
  const charges = flag(object.charges_enabled);
  const payouts = flag(object.payouts_enabled);
  const details = flag(object.details_submitted);

  try {
    await db.batch([
      // The same second as the last applied event: the two cannot be ordered.
      // Merge fail-closed NOW, and — when they disagree — mark the shop for an
      // authoritative resync: the reconciliation cron retrieves the account
      // from Stripe and writes its real flags (0027). Runs FIRST, so it can
      // only match a tie with an EARLIER event; the next statement then sees
      // synced_at = eventAt and does not match.
      db
        .prepare(
          `UPDATE tenants
           SET stripe_account_resync_needed = CASE
                 WHEN stripe_charges_enabled <> ?1 OR stripe_payouts_enabled <> ?2
                   OR stripe_details_submitted <> ?3 THEN 1
                 ELSE stripe_account_resync_needed END,
               stripe_charges_enabled = MIN(stripe_charges_enabled, ?1),
               stripe_payouts_enabled = MIN(stripe_payouts_enabled, ?2),
               stripe_details_submitted = MIN(stripe_details_submitted, ?3),
               updated_at = MAX(updated_at, ?4)
           WHERE tenant_id = ?5 AND stripe_account_id = ?6
             AND stripe_account_synced_at = ?7`,
        )
        .bind(charges, payouts, details, now, tenant.tenant_id, accountId, eventAt),
      // Newer than anything applied: the event's account state wins, and any
      // pending resync is moot (this IS a later, ordered truth).
      db
        .prepare(
          `UPDATE tenants
           SET stripe_charges_enabled = ?,
               stripe_payouts_enabled = ?,
               stripe_details_submitted = ?,
               stripe_account_synced_at = ?,
               stripe_account_resync_needed = 0,
               updated_at = MAX(updated_at, ?)
           WHERE tenant_id = ? AND stripe_account_id = ?
             AND (stripe_account_synced_at IS NULL OR stripe_account_synced_at < ?)`,
        )
        .bind(charges, payouts, details, eventAt, now, tenant.tenant_id, accountId, eventAt),
      // The reason is informational (from the read above); the two guarded
      // UPDATEs alone decide what is applied.
      recordEventStatement(
        db,
        event,
        tenant.tenant_id,
        accountId,
        "processed",
        tenant.stripe_account_synced_at !== null && tenant.stripe_account_synced_at > eventAt
          ? REASON_STALE_EVENT
          : null,
        now,
      ),
    ]);
  } catch (error) {
    if (!isDuplicateDelivery(error)) {
      throw error;
    }

    return { outcome: "processed", replayed: true };
  }

  return { outcome: "processed", replayed: false };
}
