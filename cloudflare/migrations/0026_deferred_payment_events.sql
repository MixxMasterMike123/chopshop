PRAGMA foreign_keys = ON;

-- ============================================================================
-- deferred_payment_events — Stripe facts that arrived BEFORE their order.
--
-- Stripe does not order webhook deliveries. A refund (refund.*,
-- charge.refunded) or a dispute (charge.dispute.*) can be processed while the
-- `payment_intent.succeeded` that creates the order is still being retried.
-- Such an event names a PaymentIntent that a CHECKOUT here owns but no order
-- has yet. Recording it as "ignored" loses it for good — reconciliation looks
-- for refunds only on orders — and a fully refunded payment would then enter
-- production (Codex CP2-A P1).
--
-- So the fact is parked here, normalised (ids, amounts, statuses; never the
-- raw payload, which carries billing details), in the same batch as its
-- `payment_events` ledger row. It is replayed through the ordinary, idempotent
-- appliers (refund state machine, dispute fact) right after the order batch
-- commits, by the event handler itself if the order appeared meanwhile, and by
-- every reconciliation run for anything left behind.
--
-- `event_id` is the Stripe event id (also the ledger's key), so a redelivered
-- event can never park twice. A row is immutable except for `applied_at`, set
-- once; applied rows may be deleted by a later retention sweep.
--
-- TIME: ISO-8601 UTC TEXT (PLAN §2.8), the 0013/0014/0017 round-trip CHECK.
-- ============================================================================
CREATE TABLE deferred_payment_events (
  event_id TEXT PRIMARY KEY NOT NULL CHECK (length(event_id) BETWEEN 3 AND 255),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  payment_intent_id TEXT NOT NULL CHECK (
    length(payment_intent_id) BETWEEN 3 AND 255
    AND payment_intent_id NOT GLOB '*[^A-Za-z0-9_]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('refund', 'charge_refunded', 'dispute')),
  fact_json TEXT NOT NULL CHECK (
    json_valid(fact_json)
    AND json_type(fact_json) = 'object'
    AND length(fact_json) <= 65536
  ),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  applied_at TEXT CHECK (
    applied_at IS NULL OR applied_at IS strftime('%Y-%m-%dT%H:%M:%fZ', applied_at)
  ),
  CHECK (applied_at IS NULL OR applied_at >= created_at)
);

CREATE TRIGGER deferred_payment_events_tenant_immutable
BEFORE UPDATE OF tenant_id ON deferred_payment_events
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER deferred_payment_events_facts_immutable
BEFORE UPDATE ON deferred_payment_events
FOR EACH ROW
WHEN NEW.event_id IS NOT OLD.event_id
  OR NEW.payment_intent_id IS NOT OLD.payment_intent_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.fact_json IS NOT OLD.fact_json
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS NOT OLD.applied_at)
BEGIN
  SELECT RAISE(ABORT, 'deferred payment events are immutable once applied');
END;

-- The deferring event names a checkout's intent; the tenant is that checkout's.
CREATE TRIGGER deferred_payment_events_tenant_matches_checkout
BEFORE INSERT ON deferred_payment_events
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM checkouts AS parent
  WHERE parent.payment_intent_id = NEW.payment_intent_id
)
BEGIN
  SELECT RAISE(ABORT, 'deferred payment event tenant_id must match its checkout');
END;

CREATE TRIGGER deferred_payment_events_delete_applied_only
BEFORE DELETE ON deferred_payment_events
FOR EACH ROW
WHEN OLD.applied_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'an unapplied deferred payment event cannot be deleted');
END;

CREATE INDEX deferred_payment_events_intent_idx
  ON deferred_payment_events(payment_intent_id, applied_at, created_at);
CREATE INDEX deferred_payment_events_pending_idx
  ON deferred_payment_events(applied_at, created_at);
