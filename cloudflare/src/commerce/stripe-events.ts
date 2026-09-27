import { raiseAlertStatement } from "./money-alerts";
import type { HandleWebhookEventResult } from "./payment-events";
import {
  REASON_ALREADY_APPLIED,
  REASON_MALFORMED_OBJECT,
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
 *   account.updated                tenants.stripe_* capability flags
 *   anything else                  recorded 'ignored', logged by type only
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

  const order = await db
    .prepare(
      "SELECT order_id, tenant_id FROM orders WHERE payment_intent_id = ? LIMIT 1",
    )
    .bind(intentId)
    .first<{ order_id: string; tenant_id: string }>();
  if (order === null) {
    return recordOnly(db, event, null, chargeId, "ignored", REASON_UNKNOWN_INTENT, now);
  }

  const embedded = object.refunds;
  const refundObjects =
    typeof embedded === "object" &&
    embedded !== null &&
    Array.isArray((embedded as { data?: unknown }).data)
      ? ((embedded as { data: unknown[] }).data)
      : [];

  for (const refund of refundObjects) {
    const fact: RefundFact | null = refundFactFrom(refund);
    if (fact !== null) {
      await applyRefundFact(db, { ...fact, paymentIntentId: fact.paymentIntentId ?? intentId }, now);
    }
  }

  return commitWithLedger(
    db,
    event,
    [
      db
        .prepare(
          `UPDATE orders
           SET stripe_amount_refunded_minor = MAX(stripe_amount_refunded_minor, ?),
               stripe_charge_id = COALESCE(stripe_charge_id, ?),
               updated_at = MAX(updated_at, ?)
           WHERE order_id = ?`,
        )
        .bind(amountRefunded, chargeId, now, order.order_id),
    ],
    order.tenant_id,
    chargeId,
    now,
  );
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
 */
export function nextRecovery(
  current: Recovery | null,
  status: string,
): Recovery | null {
  if (isDisputeFavourable(status)) {
    if (current === "recovered") {
      return "retransfer_pending";
    }

    if (
      current === null ||
      current === "pending_outcome" ||
      current === "reversal_pending" ||
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

  const outcome = await applyDisputeFact(
    db,
    {
      amount,
      chargeId: stripeId(object.charge),
      disputeId,
      intentId: stripeId(object.payment_intent),
      status,
    },
    now,
  );

  if (outcome.result === "unknown_order") {
    return recordOnly(db, event, null, disputeId, "ignored", REASON_UNKNOWN_ORDER, now);
  }

  if (outcome.result === "mismatch") {
    return recordOnly(db, event, outcome.tenantId, disputeId, "rejected", REASON_UNKNOWN_ORDER, now);
  }

  return recordOnly(db, event, outcome.tenantId, disputeId, "processed", null, now);
}

// ── account.updated ─────────────────────────────────────────────────────────

/**
 * Mirrors a connected account's capabilities onto its shop (Firebase
 * connectOnboarding.statusPatch). The shop is found by the account id this
 * worker stored — never by the account's metadata, which is what bound
 * Firebase's 2026-07-06 account to the wrong shop. `charges_enabled` gates the
 * payment route; `payouts_enabled` gates payout eligibility.
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

  const tenant = await db
    .prepare("SELECT tenant_id FROM tenants WHERE stripe_account_id = ? LIMIT 1")
    .bind(accountId)
    .first<{ tenant_id: string }>();
  if (tenant === null) {
    return recordOnly(db, event, null, accountId, "ignored", REASON_UNKNOWN_ACCOUNT, now);
  }

  const flag = (value: unknown) => (value === true ? 1 : 0);
  return commitWithLedger(
    db,
    event,
    [
      db
        .prepare(
          `UPDATE tenants
           SET stripe_charges_enabled = ?,
               stripe_payouts_enabled = ?,
               stripe_details_submitted = ?,
               stripe_account_synced_at = ?,
               updated_at = MAX(updated_at, ?)
           WHERE tenant_id = ? AND stripe_account_id = ?`,
        )
        .bind(
          flag(object.charges_enabled),
          flag(object.payouts_enabled),
          flag(object.details_submitted),
          now,
          now,
          tenant.tenant_id,
          accountId,
        ),
    ],
    tenant.tenant_id,
    accountId,
    now,
  );
}
