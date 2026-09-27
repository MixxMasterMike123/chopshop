PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP2-D2 — releasing the production withholding (DECISIONS D36).
--
-- The platform withholds the frozen production cost (`orders.withheld_minor`)
-- inside the application fee at charge time, to pay the printer. D9 makes the
-- fee non-refundable, so an order whose production was cancelled BEFORE it
-- reached the printer used to leave the platform holding money it would never
-- pay out, and the shop's payout negative by that amount.
--
-- A `withholding_releases` row returns EXACTLY `withheld_minor` to the shop as
-- an application-fee refund (`POST /v1/application_fees/{fee}/refunds` with
-- `amount`). The commission part of the fee stays with the platform (D9).
--
-- WHEN. An order is eligible when its production can provably never happen:
-- it is fully refunded or cancelled, it has at least one dispatch row, EVERY
-- dispatch row is `superseded` and was never submitted (`submitted_at` and
-- `unknown_since` NULL — "before submission", D36), no line was ever
-- submitting/accepted/unknown/failed or produced, and no printer cancellation
-- exists. `superseded` is final in 0021, so eligibility cannot be undone.
-- The row is born `reserved` in the refund-settlement batch that supersedes
-- the dispatch (src/commerce/refund-dispatch-stop.ts), or by the
-- reconciliation cron's discovery for the paths that supersede elsewhere (the
-- cancel route, an in-flight dispatch that honoured its cancellation later).
--
-- ONE PER ORDER (`order_id` UNIQUE): the whole withheld amount, once.
--
-- STATE MACHINE (reserve-first, like refund_operations):
--
--   reserved ──► submitted ──► succeeded
--      │             │  └────► failed
--      ├─────────────┴───────► succeeded   (a webhook fact beat the call)
--      └──────────────────────► failed      (Stripe refused)
--
--   reserved   decided; Stripe has never been asked.
--   submitted  a create call was (about to be) made with idempotency key = id.
--              Before any further create, Stripe's list of the fee's refunds
--              is read and a refund carrying metadata.withholding_release_id =
--              id settles the row instead (so a lost answer is never repeated,
--              even past Stripe's 24-hour idempotency window).
--   succeeded  Stripe holds the fee refund (`stripe_fee_refund_id`). Final.
--   failed     Stripe refused it (4xx) — a critical alert; a human decides.
--              Final: the UNIQUE order row means no automatic second attempt.
--
-- `orders.withholding_released_minor` is the payout fact: the succeeded row's
-- amount, written in the same batch as the transition to `succeeded`.
--
-- TIME: ISO-8601 UTC TEXT (PLAN §2.8), the 0013/0014/0017 round-trip CHECK.
-- MONEY: integer öre.
-- ============================================================================

ALTER TABLE orders ADD COLUMN withholding_released_minor INTEGER NOT NULL DEFAULT 0
  CHECK (withholding_released_minor >= 0);

-- Never more than was withheld, and never walked back (Stripe does not
-- reverse a fee refund).
CREATE TRIGGER orders_withholding_released_bounds
BEFORE UPDATE OF withholding_released_minor ON orders
FOR EACH ROW
WHEN NEW.withholding_released_minor > NEW.withheld_minor
  OR NEW.withholding_released_minor < OLD.withholding_released_minor
BEGIN
  SELECT RAISE(ABORT, 'withholding release bounds violated');
END;

-- The candidates the reconciliation discovery scans: POD money still held on
-- an order that is fully refunded or cancelled. The query repeats this WHERE
-- verbatim so SQLite can use the partial index.
CREATE INDEX orders_withholding_release_candidates_idx
  ON orders(paid_at)
  WHERE withheld_minor > 0
    AND withholding_released_minor = 0
    AND (cancelled_at IS NOT NULL OR (charged_minor > 0 AND refund_succeeded_minor >= charged_minor));

CREATE TABLE withholding_releases (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 16 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'submitted', 'succeeded', 'failed')),
  -- What made production impossible (informational; eligibility is the rule).
  cause TEXT NOT NULL CHECK (cause IN ('full_refund', 'order_cancelled')),
  -- Create calls made (the write-ahead to 'submitted' counts each one).
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The charge's application fee, resolved lazily from the charge.
  stripe_application_fee_id TEXT CHECK (
    stripe_application_fee_id IS NULL
    OR (length(stripe_application_fee_id) BETWEEN 3 AND 255
        AND stripe_application_fee_id NOT GLOB '*[^A-Za-z0-9_]*')
  ),
  stripe_fee_refund_id TEXT UNIQUE CHECK (
    stripe_fee_refund_id IS NULL
    OR (length(stripe_fee_refund_id) BETWEEN 3 AND 255
        AND stripe_fee_refund_id NOT GLOB '*[^A-Za-z0-9_]*')
  ),
  -- A CODE, never provider text.
  last_error TEXT CHECK (
    last_error IS NULL
    OR (length(last_error) BETWEEN 1 AND 100 AND last_error NOT GLOB '*[^A-Za-z0-9_.:-]*')
  ),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  settled_at TEXT CHECK (
    settled_at IS NULL OR settled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', settled_at)
  ),
  CHECK (updated_at >= created_at),
  -- A fee refund is synchronous at Stripe: its id exists exactly when it
  -- succeeded.
  CHECK ((state = 'succeeded') = (stripe_fee_refund_id IS NOT NULL)),
  CHECK ((state IN ('succeeded', 'failed')) = (settled_at IS NOT NULL))
);

CREATE TRIGGER withholding_releases_identity_immutable
BEFORE UPDATE ON withholding_releases
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.order_id IS NOT OLD.order_id
  OR NEW.amount_minor IS NOT OLD.amount_minor
  OR NEW.cause IS NOT OLD.cause
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.attempts < OLD.attempts
  OR (OLD.stripe_application_fee_id IS NOT NULL
      AND NEW.stripe_application_fee_id IS NOT OLD.stripe_application_fee_id)
  OR (OLD.stripe_fee_refund_id IS NOT NULL
      AND NEW.stripe_fee_refund_id IS NOT OLD.stripe_fee_refund_id)
BEGIN
  SELECT RAISE(ABORT, 'withholding release identity is immutable');
END;

CREATE TRIGGER withholding_releases_state_machine
BEFORE UPDATE OF state ON withholding_releases
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state AND NOT (
  (OLD.state = 'reserved' AND NEW.state IN ('submitted', 'succeeded', 'failed'))
  OR (OLD.state = 'submitted' AND NEW.state IN ('succeeded', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'withholding release state transition is not allowed');
END;

-- Settled rows are final: nothing about them moves again.
CREATE TRIGGER withholding_releases_final_frozen
BEFORE UPDATE ON withholding_releases
FOR EACH ROW
WHEN OLD.state IN ('succeeded', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'withholding release is final');
END;

-- Born reserved, for exactly the order's withheld amount, in the order's
-- tenant.
CREATE TRIGGER withholding_releases_birth
BEFORE INSERT ON withholding_releases
FOR EACH ROW
WHEN NEW.state IS NOT 'reserved'
  OR NEW.attempts IS NOT 0
  OR NEW.tenant_id IS NOT (SELECT o.tenant_id FROM orders AS o WHERE o.order_id = NEW.order_id)
  OR NEW.amount_minor IS NOT (SELECT o.withheld_minor FROM orders AS o WHERE o.order_id = NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'a withholding release is born reserved for the order''s withheld amount');
END;

CREATE TRIGGER withholding_releases_no_delete
BEFORE DELETE ON withholding_releases
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'withholding releases are append-only');
END;

CREATE INDEX withholding_releases_state_idx
  ON withholding_releases(state, updated_at);
CREATE INDEX withholding_releases_fee_idx
  ON withholding_releases(stripe_application_fee_id)
  WHERE stripe_application_fee_id IS NOT NULL;
