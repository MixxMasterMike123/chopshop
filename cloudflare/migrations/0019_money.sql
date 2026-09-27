PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP2-A — money (PLAN §2.3): Connect destination charges, production
-- withholding, reserve-before-Stripe refunds, dispute recovery, payout facts,
-- the production snapshot copied onto the order, and retention bookkeeping.
--
-- TIME. New TABLES use ISO-8601 UTC TEXT (PLAN §2.8) with the same strftime
-- round-trip CHECK as 0013/0014/0017. New COLUMNS on existing tables follow
-- that table's own convention: `tenants`, `checkouts` and `orders` keep
-- INTEGER epoch milliseconds, so every comparison on those tables stays one
-- type.
--
-- MONEY is integer minor units (öre) everywhere. Nothing here stores a float.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- tenants — the shop's Stripe Connect account (Firebase: shops/{id}.payments).
--
-- A checkout is payable only when `stripe_account_id` is set AND
-- `stripe_charges_enabled = 1` (src/commerce/payment.ts, fail closed). The
-- flags mirror Stripe's Account object and are written by `account.updated`
-- (src/commerce/stripe-events.ts). `commission_bps` is the per-shop platform
-- cut in basis points; NULL means the platform default (500 = 5 %,
-- functions/src/config/app-urls.ts `PLATFORM_DEFAULT_COMMISSION_BPS`).
-- ----------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN stripe_account_id TEXT CHECK (
  stripe_account_id IS NULL
  OR (
    length(stripe_account_id) BETWEEN 6 AND 255
    AND substr(stripe_account_id, 1, 5) = 'acct_'
    AND stripe_account_id NOT GLOB '*[^A-Za-z0-9_]*'
  )
);
ALTER TABLE tenants ADD COLUMN stripe_charges_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (stripe_charges_enabled IN (0, 1));
ALTER TABLE tenants ADD COLUMN stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (stripe_payouts_enabled IN (0, 1));
ALTER TABLE tenants ADD COLUMN stripe_details_submitted INTEGER NOT NULL DEFAULT 0
  CHECK (stripe_details_submitted IN (0, 1));
ALTER TABLE tenants ADD COLUMN stripe_account_synced_at INTEGER;
ALTER TABLE tenants ADD COLUMN commission_bps INTEGER CHECK (
  commission_bps IS NULL OR (commission_bps BETWEEN 0 AND 10000)
);

-- One connected account belongs to one shop. (Firebase's 2026-07-06 incident
-- was exactly an account bound to the wrong shop.) ALTER cannot add UNIQUE, so
-- a partial unique index carries it.
CREATE UNIQUE INDEX tenants_stripe_account_idx
  ON tenants(stripe_account_id) WHERE stripe_account_id IS NOT NULL;

-- A capability flag without an account is meaningless and would make the
-- payment gate's "account AND enabled" test depend on which half a writer
-- remembered. Both write paths are guarded.
CREATE TRIGGER tenants_connect_flags_need_account_insert
BEFORE INSERT ON tenants
FOR EACH ROW
WHEN (NEW.stripe_charges_enabled = 1 OR NEW.stripe_payouts_enabled = 1)
  AND NEW.stripe_account_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'connect capability flags require a stripe account');
END;

CREATE TRIGGER tenants_connect_flags_need_account_update
BEFORE UPDATE ON tenants
FOR EACH ROW
WHEN (NEW.stripe_charges_enabled = 1 OR NEW.stripe_payouts_enabled = 1)
  AND NEW.stripe_account_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'connect capability flags require a stripe account');
END;


-- ----------------------------------------------------------------------------
-- checkouts — the Connect facts frozen when the PaymentIntent is attached, and
-- the PaymentIntent's last known state for the retention sweep.
--
--   connect_account_id / application_fee_minor / withheld_minor
--     Written ONCE, in the same guarded UPDATE that attaches the intent
--     (payment.ts). The order copies them; refunds and payouts read the
--     order's copy. `application_fee_minor` = commission + `withheld_minor`
--     (the production cost the platform keeps to pay the printer, LAUNCH_TODO
--     A1); it never exceeds the checkout total.
--
--   payment_intent_status / payment_intent_status_at
--     The intent's last state change as this worker learned it (creation,
--     payment_failed, canceled, succeeded, or the sweep's own cancel). The
--     retention sweep keeps a snapshot for >= 7 days after this moment.
--     'succeeded' and 'canceled' are Stripe-terminal and never left.
--
--   snapshot_purged_at
--     When the retention sweep cleared `production_snapshot_json` (a column
--     owned by the POD checkout builder). NULL = never purged.
-- ----------------------------------------------------------------------------
ALTER TABLE checkouts ADD COLUMN connect_account_id TEXT CHECK (
  connect_account_id IS NULL
  OR (
    length(connect_account_id) BETWEEN 6 AND 255
    AND substr(connect_account_id, 1, 5) = 'acct_'
    AND connect_account_id NOT GLOB '*[^A-Za-z0-9_]*'
  )
);
ALTER TABLE checkouts ADD COLUMN application_fee_minor INTEGER CHECK (
  application_fee_minor IS NULL OR application_fee_minor >= 0
);
ALTER TABLE checkouts ADD COLUMN withheld_minor INTEGER CHECK (
  withheld_minor IS NULL OR withheld_minor >= 0
);
ALTER TABLE checkouts ADD COLUMN payment_intent_status TEXT CHECK (
  payment_intent_status IS NULL
  OR (
    length(payment_intent_status) BETWEEN 1 AND 40
    AND payment_intent_status NOT GLOB '*[^a-z_]*'
  )
);
ALTER TABLE checkouts ADD COLUMN payment_intent_status_at INTEGER;
ALTER TABLE checkouts ADD COLUMN snapshot_purged_at INTEGER;

-- The three Connect facts travel together and are frozen once written: the
-- webhook, refunds and payouts all trust that the fee on the row is the fee
-- Stripe was asked to take.
CREATE TRIGGER checkouts_connect_facts_frozen
BEFORE UPDATE OF connect_account_id, application_fee_minor, withheld_minor ON checkouts
FOR EACH ROW
WHEN (OLD.connect_account_id IS NOT NULL AND NEW.connect_account_id IS NOT OLD.connect_account_id)
  OR (OLD.application_fee_minor IS NOT NULL AND NEW.application_fee_minor IS NOT OLD.application_fee_minor)
  OR (OLD.withheld_minor IS NOT NULL AND NEW.withheld_minor IS NOT OLD.withheld_minor)
BEGIN
  SELECT RAISE(ABORT, 'checkout connect facts are frozen');
END;

CREATE TRIGGER checkouts_connect_facts_coherent
BEFORE UPDATE OF connect_account_id, application_fee_minor, withheld_minor ON checkouts
FOR EACH ROW
WHEN ((NEW.connect_account_id IS NULL) IS NOT (NEW.application_fee_minor IS NULL))
  OR ((NEW.application_fee_minor IS NULL) IS NOT (NEW.withheld_minor IS NULL))
  OR (NEW.application_fee_minor IS NOT NULL AND (
    NEW.application_fee_minor > NEW.total_minor
    OR NEW.withheld_minor > NEW.application_fee_minor
  ))
BEGIN
  SELECT RAISE(ABORT, 'checkout connect facts are incoherent');
END;

-- Stripe never moves an intent out of 'succeeded' or 'canceled'. A late event
-- carrying an older status must not regress what this worker already knows.
CREATE TRIGGER checkouts_payment_intent_status_terminal
BEFORE UPDATE OF payment_intent_status ON checkouts
FOR EACH ROW
WHEN OLD.payment_intent_status IN ('succeeded', 'canceled')
  AND NEW.payment_intent_status IS NOT OLD.payment_intent_status
BEGIN
  SELECT RAISE(ABORT, 'payment intent status is terminal');
END;

CREATE INDEX checkouts_retention_idx
  ON checkouts(status, payment_intent_status, payment_intent_status_at);


-- ----------------------------------------------------------------------------
-- orders — money facts. Every value below is either copied from the checkout
-- at order creation (frozen) or accumulated from Stripe facts.
--
--   charged_minor            what Stripe captured (= captured_minor); the
--                            refund ceiling. Frozen.
--   refund_succeeded_minor   Σ settled refunds. `refunded_total_minor` (0011)
--                            is kept equal to it for the existing readers.
--   refund_reserved_minor    Σ refunds requested but not yet settled
--                            (refund_operations in 'reserved'/'submitted').
--   refund_version           bumped on every change to the two above; the
--                            optimistic-concurrency guard of the reservation.
--   last_refund_op_id        the operation whose reservation last bumped the
--                            version: lets the reservation batch prove that
--                            ITS guarded UPDATE applied (see refunds.ts).
--   application_fee_minor    the ONE platform deduction (commission + the
--                            production withholding). Frozen. The only fee
--                            figure a tenant admin ever sees.
--   withheld_minor           the production cost inside the fee. Frozen.
--                            SERVER-ONLY: never in a tenant-admin response.
--   connect_account_id       the destination the charge transferred to. Frozen.
--   transfer_reversed_minor  transfer reversals OUTSIDE refunds (dispute
--                            recovery). A refund's own reversal is Stripe's
--                            proportional `reverse_transfer`, which for a
--                            destination charge (transfer = gross) equals the
--                            refund amount and is already counted in
--                            refund_succeeded_minor.
--   dispute_*                the charge's dispute and its recovery state.
--   payout_state             pending | eligible | paid | blocked — a stored
--                            view refreshed by the webhook and the
--                            reconciliation cron (payouts.ts derives it).
--   stripe_charge_id / stripe_transfer_id
--                            the charge and its destination transfer; the
--                            transfer id is resolved lazily by dispute
--                            recovery when an event did not carry it.
--   stripe_amount_refunded_minor
--                            the highest `charge.amount_refunded` Stripe has
--                            reported. Greater than refund_succeeded_minor ⇒
--                            refunds this worker has not settled yet; the
--                            reconciliation cron lists them from Stripe.
--   production_snapshot_json the checkout's frozen production snapshot, copied
--                            opaquely at order creation. SERVER-ONLY.
-- ----------------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN production_snapshot_json TEXT CHECK (
  production_snapshot_json IS NULL
  OR (
    json_valid(production_snapshot_json)
    AND json_type(production_snapshot_json) = 'object'
    AND length(production_snapshot_json) <= 262144
  )
);
ALTER TABLE orders ADD COLUMN charged_minor INTEGER NOT NULL DEFAULT 0
  CHECK (charged_minor >= 0);
ALTER TABLE orders ADD COLUMN refund_succeeded_minor INTEGER NOT NULL DEFAULT 0
  CHECK (refund_succeeded_minor >= 0);
ALTER TABLE orders ADD COLUMN refund_reserved_minor INTEGER NOT NULL DEFAULT 0
  CHECK (refund_reserved_minor >= 0);
ALTER TABLE orders ADD COLUMN refund_version INTEGER NOT NULL DEFAULT 0
  CHECK (refund_version >= 0);
ALTER TABLE orders ADD COLUMN last_refund_op_id TEXT;
ALTER TABLE orders ADD COLUMN application_fee_minor INTEGER NOT NULL DEFAULT 0
  CHECK (application_fee_minor >= 0);
ALTER TABLE orders ADD COLUMN withheld_minor INTEGER NOT NULL DEFAULT 0
  CHECK (withheld_minor >= 0);
ALTER TABLE orders ADD COLUMN connect_account_id TEXT;
ALTER TABLE orders ADD COLUMN transfer_reversed_minor INTEGER NOT NULL DEFAULT 0
  CHECK (transfer_reversed_minor >= 0);
ALTER TABLE orders ADD COLUMN dispute_id TEXT CHECK (
  dispute_id IS NULL
  OR (length(dispute_id) BETWEEN 3 AND 255 AND dispute_id NOT GLOB '*[^A-Za-z0-9_]*')
);
-- Stripe's own dispute status, stored as given (a shape check rather than an
-- allowlist, so a status Stripe adds later cannot make the webhook's batch
-- abort and retry forever). payouts.ts classifies it; unknown ⇒ open.
ALTER TABLE orders ADD COLUMN dispute_status TEXT CHECK (
  dispute_status IS NULL
  OR (length(dispute_status) BETWEEN 1 AND 40 AND dispute_status NOT GLOB '*[^a-z_]*')
);
ALTER TABLE orders ADD COLUMN dispute_amount_minor INTEGER NOT NULL DEFAULT 0
  CHECK (dispute_amount_minor >= 0);
ALTER TABLE orders ADD COLUMN dispute_recovery TEXT CHECK (
  dispute_recovery IS NULL OR dispute_recovery IN (
    'pending_outcome', 'reversal_pending', 'recovered', 'no_transfer',
    'shortfall', 'retransfer_pending', 'returned_won', 'retransfer_failed',
    'won_no_reversal'
  )
);
ALTER TABLE orders ADD COLUMN dispute_reversal_id TEXT;
ALTER TABLE orders ADD COLUMN dispute_retransfer_id TEXT;
ALTER TABLE orders ADD COLUMN dispute_retransferred_minor INTEGER NOT NULL DEFAULT 0
  CHECK (dispute_retransferred_minor >= 0);
ALTER TABLE orders ADD COLUMN dispute_updated_at INTEGER;
ALTER TABLE orders ADD COLUMN payout_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (payout_state IN ('pending', 'eligible', 'paid', 'blocked'));
ALTER TABLE orders ADD COLUMN stripe_charge_id TEXT CHECK (
  stripe_charge_id IS NULL
  OR (length(stripe_charge_id) BETWEEN 3 AND 255 AND stripe_charge_id NOT GLOB '*[^A-Za-z0-9_]*')
);
ALTER TABLE orders ADD COLUMN stripe_transfer_id TEXT CHECK (
  stripe_transfer_id IS NULL
  OR (length(stripe_transfer_id) BETWEEN 3 AND 255 AND stripe_transfer_id NOT GLOB '*[^A-Za-z0-9_]*')
);
ALTER TABLE orders ADD COLUMN stripe_amount_refunded_minor INTEGER NOT NULL DEFAULT 0
  CHECK (stripe_amount_refunded_minor >= 0);

-- Rows written before this migration captured exactly `captured_minor`.
UPDATE orders SET charged_minor = captured_minor;

-- The new frozen facts join 0011's financial identity. Written once, at
-- order creation, by the webhook.
CREATE TRIGGER orders_connect_facts_immutable
BEFORE UPDATE ON orders
FOR EACH ROW
WHEN NEW.charged_minor IS NOT OLD.charged_minor
  OR NEW.application_fee_minor IS NOT OLD.application_fee_minor
  OR NEW.withheld_minor IS NOT OLD.withheld_minor
  OR NEW.connect_account_id IS NOT OLD.connect_account_id
  OR NEW.production_snapshot_json IS NOT OLD.production_snapshot_json
BEGIN
  SELECT RAISE(ABORT, 'order connect facts are immutable');
END;

-- The refund arithmetic, as schema facts. Settled refunds never exceed the
-- charge (Stripe enforces the same bound on its side, so a recorded fact can
-- never need to break it). The RESERVATION invariant
-- `succeeded + reserved <= charged` is deliberately NOT a trigger: it is what
-- the reservation's guarded UPDATE enforces for admin requests, while a
-- dashboard refund is a fact that must be recorded even if it lands while an
-- admin reservation is in flight (the loser is then refused by Stripe and
-- released).
CREATE TRIGGER orders_refund_bounds_insert
BEFORE INSERT ON orders
FOR EACH ROW
WHEN NEW.refund_succeeded_minor > NEW.charged_minor
  OR NEW.application_fee_minor > NEW.charged_minor
  OR NEW.withheld_minor > NEW.application_fee_minor
  OR NEW.refunded_total_minor IS NOT NEW.refund_succeeded_minor
BEGIN
  SELECT RAISE(ABORT, 'order refund bounds violated');
END;

CREATE TRIGGER orders_refund_bounds_update
BEFORE UPDATE OF refund_succeeded_minor, refunded_total_minor ON orders
FOR EACH ROW
WHEN NEW.refund_succeeded_minor > NEW.charged_minor
  OR NEW.refunded_total_minor IS NOT NEW.refund_succeeded_minor
BEGIN
  SELECT RAISE(ABORT, 'order refund bounds violated');
END;

CREATE INDEX orders_payout_idx ON orders(payout_state, paid_at);
CREATE INDEX orders_dispute_idx ON orders(dispute_recovery, dispute_updated_at);
CREATE INDEX orders_charge_idx ON orders(stripe_charge_id);


-- ----------------------------------------------------------------------------
-- order_items.production_json — the snapshot's `lines[]` entry for this line
-- (`lineNo` = item_index + 1), copied opaquely. NULL for a non-POD line.
-- SERVER-ONLY, frozen with the rest of the line.
-- ----------------------------------------------------------------------------
ALTER TABLE order_items ADD COLUMN production_json TEXT CHECK (
  production_json IS NULL
  OR (
    json_valid(production_json)
    AND json_type(production_json) = 'object'
    AND length(production_json) <= 65536
  )
);

CREATE TRIGGER order_items_production_immutable
BEFORE UPDATE OF production_json ON order_items
FOR EACH ROW
WHEN NEW.production_json IS NOT OLD.production_json
BEGIN
  SELECT RAISE(ABORT, 'order item snapshots are immutable');
END;


-- ----------------------------------------------------------------------------
-- refund_operations — reserve before Stripe (PLAN §2.3).
--
-- One row per refund, whoever asked for it:
--   origin 'admin'   a tenant admin's request. Born 'reserved' in the same
--                    batch that adds its amount to orders.refund_reserved_minor
--                    under the refund_version guard; then Stripe is called with
--                    idempotency key = id.
--   origin 'stripe'  a refund this worker did not request (the Stripe
--                    dashboard). Born from the webhook fact, already
--                    'submitted', 'succeeded' or 'failed'.
--
--   reserved  ──► submitted ──► succeeded ──► failed (a late card failure)
--      │   └────────────────────► succeeded
--      ├──► failed      (Stripe refused; the reservation is released)
--      └──► released    (Stripe never received it; reconciliation, > 30 min)
--   released ──► submitted | succeeded | failed   (Stripe later proved it did)
--
-- A row holds a reservation exactly while it is 'reserved' or 'submitted'.
-- Settlement is deduped by `stripe_refund_id` (UNIQUE). `prev_state` and
-- `transition_id` are bookkeeping for the one-batch transition in refunds.ts:
-- the transition UPDATE stamps a fresh transition id and the order's money
-- UPDATE in the same batch applies only if that stamp is present, so a replay
-- or a concurrent settlement can never move money twice.
-- ----------------------------------------------------------------------------
CREATE TABLE refund_operations (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'submitted', 'succeeded', 'failed', 'released')),
  prev_state TEXT CHECK (
    prev_state IS NULL OR prev_state IN ('reserved', 'submitted', 'succeeded', 'failed', 'released')
  ),
  stripe_refund_id TEXT UNIQUE CHECK (
    stripe_refund_id IS NULL
    OR (length(stripe_refund_id) BETWEEN 3 AND 255 AND stripe_refund_id NOT GLOB '*[^A-Za-z0-9_]*')
  ),
  origin TEXT NOT NULL CHECK (origin IN ('admin', 'stripe')),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  created_by TEXT,
  transition_id TEXT,
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK (updated_at >= created_at),
  CHECK ((origin = 'admin') = (created_by IS NOT NULL)),
  -- An admin request is always born reserved; only a Stripe fact can be born
  -- in a later state.
  CHECK (origin = 'stripe' OR prev_state IS NOT NULL OR state = 'reserved')
);

CREATE TRIGGER refund_operations_tenant_immutable
BEFORE UPDATE OF tenant_id ON refund_operations
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER refund_operations_identity_immutable
BEFORE UPDATE ON refund_operations
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.order_id IS NOT OLD.order_id
  OR NEW.amount_minor IS NOT OLD.amount_minor
  OR NEW.origin IS NOT OLD.origin
  OR NEW.reason IS NOT OLD.reason
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.stripe_refund_id IS NOT NULL AND NEW.stripe_refund_id IS NOT OLD.stripe_refund_id)
BEGIN
  SELECT RAISE(ABORT, 'refund operation identity is immutable');
END;

CREATE TRIGGER refund_operations_state_machine
BEFORE UPDATE OF state ON refund_operations
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state AND NOT (
  (OLD.state = 'reserved' AND NEW.state IN ('submitted', 'succeeded', 'failed', 'released'))
  OR (OLD.state = 'submitted' AND NEW.state IN ('succeeded', 'failed'))
  OR (OLD.state = 'succeeded' AND NEW.state = 'failed')
  OR (OLD.state = 'released' AND NEW.state IN ('submitted', 'succeeded', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'refund operation state transition is not allowed');
END;

CREATE TRIGGER refund_operations_tenant_matches_order
BEFORE INSERT ON refund_operations
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM orders AS parent WHERE parent.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'refund operation tenant_id must match order tenant_id');
END;

CREATE TRIGGER refund_operations_no_delete
BEFORE DELETE ON refund_operations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'refund operations are append-only');
END;

CREATE INDEX refund_operations_order_idx
  ON refund_operations(tenant_id, order_id, created_at);
CREATE INDEX refund_operations_state_idx
  ON refund_operations(state, updated_at);
