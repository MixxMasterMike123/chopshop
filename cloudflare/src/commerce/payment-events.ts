import type { VerifiedStripeEvent } from "./stripe-client";

/**
 * The `payment_events` ledger (0011): one row per Stripe event id, whatever the
 * event did. Shared by the order path (webhook.ts) and every other event
 * handler (stripe-events.ts), so "has this event been seen" has one answer.
 *
 * The ledger is the dedupe authority for EVENTS. Effects that several events
 * can carry — a refund reported by refund.created, refund.updated and
 * charge.refunded — are additionally idempotent on their own key (the refund
 * id, through the refund_operations state machine), so a ledger row that was
 * lost after its effects committed is harmless: the redelivery re-applies
 * nothing and records the row.
 */

export type WebhookOutcome = "processed" | "ignored" | "rejected";

/**
 * Why a delivery produced no effect, or what it did. Enumerated codes, never
 * provider text: they land in `payment_events.reason_code` and are the only
 * explanation an operator gets.
 */
export const REASON_UNHANDLED_TYPE = "unhandled_event_type";
export const REASON_UNKNOWN_INTENT = "unknown_payment_intent";
export const REASON_CHECKOUT_NOT_PAYABLE = "checkout_not_payable";
export const REASON_AMOUNT_MISMATCH = "amount_mismatch";
export const REASON_METADATA_MISMATCH = "metadata_mismatch";
export const REASON_MALFORMED_OBJECT = "malformed_object";
export const REASON_UNKNOWN_ORDER = "unknown_order";
export const REASON_UNKNOWN_ACCOUNT = "unknown_account";
export const REASON_ALREADY_APPLIED = "already_applied";
export const REASON_REFUND_AMOUNT_MISMATCH = "refund_amount_mismatch";
/** Parked in deferred_payment_events until the order exists (0026). */
export const REASON_DEFERRED_UNTIL_ORDER = "deferred_until_order";
export const REASON_STALE_EVENT = "stale_event";
/** A non-Connect event verified by the Connect endpoint's secret. */
export const REASON_WRONG_ENDPOINT = "ignored_wrong_endpoint";

export interface HandleWebhookEventResult {
  outcome: WebhookOutcome;
  /** Present only when this delivery created the order. */
  orderId?: string;
  reasonCode?: string;
  /** True when the event id had already been recorded — a clean replay. */
  replayed: boolean;
}

/**
 * Has this exact event already been recorded?
 *
 * The read is the FAST path, not the guarantee. `payment_events.event_id` is a
 * PRIMARY KEY and the insert rides in the same batch as every effect, so two
 * deliveries racing past this read cannot both commit: one batch wins and the
 * other fails the primary key, whereupon the caller answers 200.
 */
export async function findRecordedEvent(
  db: D1Database,
  eventId: string,
): Promise<{ outcome: string; reason_code: string | null } | null> {
  return db
    .prepare(
      "SELECT outcome, reason_code FROM payment_events WHERE event_id = ? LIMIT 1",
    )
    .bind(eventId)
    .first<{ outcome: string; reason_code: string | null }>();
}

export function recordEventStatement(
  db: D1Database,
  event: VerifiedStripeEvent,
  tenantId: string | null,
  objectId: string | null,
  outcome: WebhookOutcome,
  reasonCode: string | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO payment_events (
        event_id, tenant_id, provider, event_type, object_id,
        outcome, reason_code, received_at, created_at
      ) VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.id,
      tenantId,
      event.type,
      objectId,
      outcome,
      reasonCode,
      now,
      now,
    );
}

/**
 * Whether a batch failed because another delivery got there first.
 *
 * Narrowed to the constraints that mean exactly that — the event ledger's
 * primary key and the order's one-per-checkout uniqueness — rather than
 * matching any UNIQUE violation. A broad match would swallow a genuine
 * collision, such as the order-number uniqueness the order batch also relies
 * on, and report a lost order as a harmless replay.
 */
export function isDuplicateDelivery(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("UNIQUE constraint failed")) {
    // SQLite reports a primary-key collision on a rowid table this way.
    return message.includes("payment_events.event_id");
  }

  return (
    message.includes("payment_events.event_id") ||
    message.includes("orders.checkout_id") ||
    message.includes("orders.payment_intent_id")
  );
}

/**
 * Records a delivery whose effects (if any) are already committed or that has
 * none. Its own single-statement write, still guarded, since two racing
 * deliveries of one event would both try to write the ledger row.
 */
export async function recordOnly(
  db: D1Database,
  event: VerifiedStripeEvent,
  tenantId: string | null,
  objectId: string | null,
  outcome: WebhookOutcome,
  reasonCode: string | null,
  now: number,
): Promise<HandleWebhookEventResult> {
  try {
    await recordEventStatement(
      db,
      event,
      tenantId,
      objectId,
      outcome,
      reasonCode,
      now,
    ).run();
  } catch (error) {
    if (!isDuplicateDelivery(error)) {
      throw error;
    }

    return {
      outcome,
      ...(reasonCode === null ? {} : { reasonCode }),
      replayed: true,
    };
  }

  return {
    outcome,
    ...(reasonCode === null ? {} : { reasonCode }),
    replayed: false,
  };
}
