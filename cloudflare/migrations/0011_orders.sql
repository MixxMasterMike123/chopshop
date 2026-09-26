PRAGMA foreign_keys = ON;

-- Orders: the durable record a paid checkout becomes.
--
-- Written by exactly one code path — the Stripe webhook (src/commerce/webhook.ts)
-- on a verified `payment_intent.succeeded`. There is no HTTP surface that creates
-- an order, and there must never be one: an order is the assertion that money
-- moved, and only the payment provider can make that assertion.
--
-- SOURCE OF TRUTH. Production reconstructs the order FROM PaymentIntent metadata
-- (functions/src/payment/stripeWebhook.ts reads metadata.customerEmail,
-- metadata.itemDetails, metadata.subtotal, ... and stores what it finds). This
-- schema deliberately cannot be filled that way: every money column below is
-- copied from the `checkouts` row the webhook looked up by `payment_intent_id`,
-- and that row's totals were frozen by the server at quote time and are policed
-- by 0009's and 0010's CHECKs. Stripe metadata is dashboard-readable, exported,
-- and retained on Stripe's schedule; treating it as authority would mean a
-- tampered or drifted metadata blob could write a different price into a
-- financial record. The join key is all metadata is trusted for, and even that is
-- only ever a cross-check — the UNIQUE `checkouts.payment_intent_id` column is
-- what actually finds the row.
--
-- REFUNDS ARE NOT BUILT IN THIS CHECKPOINT, but the shape must not preclude
-- them. Production's 2026-08 audit added cumulative partial refunds
-- (functions/src/payment/connectRefund.ts writes payment.refundedTotalSek as an
-- ABSOLUTE cumulative figure precisely so a replayed refund converges rather than
-- double-counting), and `partially_refunded` is a real order status there —
-- print/outboxCore.ts even treats it as production-ready. So:
--   * `status` already admits 'partially_refunded' and 'refunded' in its
--     allowlist, and `refunded_total_minor` exists as a cumulative column with a
--     ceiling of the captured total. Neither is writable by this checkpoint's
--     code; both are here so the refund checkpoint adds behaviour, not a
--     migration that rewrites a table holding real money.
--   * `order_status_history` is append-only from day one, so a later refund
--     transition lands beside the paid transition rather than overwriting it.
CREATE TABLE orders (
  order_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The checkout this order was made from. UNIQUE is the structural half of the
  -- idempotency guarantee: however many times Stripe delivers the event, and
  -- however many deliveries race, ONE checkout can produce at most ONE order.
  -- The application's guarded writes make a duplicate a clean no-op; this
  -- constraint makes it impossible even if that logic were wrong.
  --
  -- NOT NULL because there is no other way to make an order here. A future
  -- B2B/manual order path would need its own nullable column or its own table;
  -- it must not weaken this one to get itself written.
  checkout_id TEXT NOT NULL UNIQUE REFERENCES checkouts(checkout_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The provider's identity for the money. UNIQUE for the same reason: one
  -- PaymentIntent can never be claimed by two orders, so a metadata-forged
  -- delivery naming an intent that already paid for something cannot fork the
  -- record. Mirrors the data model's `UNIQUE(provider, payment_intent_id)` on
  -- `payments`; a dedicated payments table is a later checkpoint's job, and
  -- inventing an empty one now would be a table with no writer.
  payment_intent_id TEXT NOT NULL UNIQUE,
  -- Human-facing reference. UNIQUE per tenant, matching the data model. Prod
  -- generates `PREFIX-{last 6 epoch digits}-{4 random base36}` with NO
  -- uniqueness check against the database (stripeWebhook.ts) — the truncated
  -- timestamp wraps every ~16.7 minutes and collisions are unbounded, merely
  -- unlikely. Here the constraint is real, and the generator is a full random
  -- token rather than a time-derived one; see the note in webhook.ts.
  order_number TEXT NOT NULL,
  -- The allowlist. 'paid' is the only status this checkpoint writes; the rest
  -- are declared now so later transitions land against a constrained column
  -- rather than a free one, exactly as 0007 declared checkout statuses it could
  -- not yet reach. The vocabulary is the subset of the data model's proposed
  -- graph that a B2C card order can actually occupy.
  status TEXT NOT NULL CHECK (status IN (
    'paid', 'processing', 'printed', 'shipped', 'ready_for_pickup',
    'delivered', 'completed', 'partially_refunded', 'refunded', 'cancelled'
  )),
  -- Buyer identity, snapshotted. Copied from the checkout row rather than joined
  -- at read time: the checkout may be swept, and an order must remain readable
  -- and shippable on its own terms years later.
  customer_email TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  -- Fulfilment instructions, frozen. Same equivalence 0009 states for checkouts:
  -- a collected order has no destination, and a destination implies a shipped
  -- one. Restated here rather than inherited because this table must be sound in
  -- isolation — nothing stops a future reader from consulting only the order.
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('shipping', 'pickup')),
  shipping_country TEXT CHECK (
    (delivery_method = 'pickup') = (shipping_country IS NULL)
    AND (
      shipping_country IS NULL
      OR (
        length(shipping_country) = 2
        AND shipping_country GLOB '[A-Z][A-Z]'
      )
    )
  ),
  -- The money, copied verbatim from the checkout and re-policed here. Every
  -- constraint 0009/0010 place on a checkout is restated, so an order can never
  -- hold an arithmetic that a checkout could not.
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  shipping_minor INTEGER NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
  vat_minor INTEGER NOT NULL DEFAULT 0,
  vat_rate_bp INTEGER NOT NULL CHECK (vat_rate_bp >= 0 AND vat_rate_bp <= 10000),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  -- The discount code that authorized the discount, frozen. No foreign key, for
  -- the same reason 0010 gives on `checkouts.discount_code_id`: a merchant may
  -- delete a campaign next month and this row must survive unchanged. It is the
  -- reconciliation breadcrumb for the used_count this order burned.
  discount_code_id TEXT,
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  -- What the provider actually captured, in the provider's minor units. Stored
  -- SEPARATELY from total_minor and constrained equal to it on insert by the
  -- application, not by a CHECK — because a later partial capture or a
  -- multi-capture flow is a real thing, and pinning them equal in the schema
  -- would make that a migration rather than a feature. Today they always agree,
  -- and the webhook refuses to create an order when they do not.
  captured_minor INTEGER NOT NULL CHECK (captured_minor >= 0),
  -- Cumulative refunds, absolute rather than incremental — prod's
  -- refundedTotalSek is absolute for exactly this reason (a replayed refund
  -- event converges instead of double-counting). Not writable by this
  -- checkpoint; the ceiling is what makes "refunds cannot exceed capture" a
  -- schema fact rather than a code convention.
  refunded_total_minor INTEGER NOT NULL DEFAULT 0
    CHECK (refunded_total_minor >= 0 AND refunded_total_minor <= captured_minor),
  -- The Stripe event that created this order. Kept for reconciliation and for
  -- the operator question "which delivery did this?", never as an authorization
  -- or dedupe key — `payment_events` below owns dedupe.
  stripe_event_id TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  -- The v2 totals contract, restated. VAT is CONTAINED in the total, so it is
  -- deliberately absent from this equation; see 0009.
  CHECK (total_minor = subtotal_minor + shipping_minor - discount_minor),
  CHECK (vat_minor >= 0 AND vat_minor <= total_minor),
  CHECK (delivery_method <> 'pickup' OR shipping_minor = 0),
  -- 0010's rule, restated: discounted money was authorized by something, and a
  -- discount never eats the carriage.
  CHECK (
    ((discount_minor = 0) OR (discount_code_id IS NOT NULL))
    AND discount_minor <= subtotal_minor
  ),
  UNIQUE (tenant_id, order_number)
);

CREATE TRIGGER orders_tenant_immutable
BEFORE UPDATE OF tenant_id ON orders
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- The financial identity of an order is frozen the moment it is written.
--
-- This is the strongest trigger in the schema and it is meant to be. Everything
-- it names is either what the buyer was charged or what the money was charged
-- against; none of it has a legitimate reason to change, and a bug, a repair
-- script, or a future "just fix this one order" admin surface that tried would
-- be silently rewriting a financial record. Status, refund total, and updated_at
-- are deliberately NOT listed — those are the fields the lifecycle moves.
CREATE TRIGGER orders_money_immutable
BEFORE UPDATE ON orders
FOR EACH ROW
WHEN NEW.checkout_id IS NOT OLD.checkout_id
  OR NEW.payment_intent_id IS NOT OLD.payment_intent_id
  OR NEW.order_number IS NOT OLD.order_number
  OR NEW.customer_email IS NOT OLD.customer_email
  OR NEW.currency IS NOT OLD.currency
  OR NEW.delivery_method IS NOT OLD.delivery_method
  OR NEW.shipping_country IS NOT OLD.shipping_country
  OR NEW.subtotal_minor IS NOT OLD.subtotal_minor
  OR NEW.shipping_minor IS NOT OLD.shipping_minor
  OR NEW.vat_minor IS NOT OLD.vat_minor
  OR NEW.vat_rate_bp IS NOT OLD.vat_rate_bp
  OR NEW.discount_minor IS NOT OLD.discount_minor
  OR NEW.discount_code_id IS NOT OLD.discount_code_id
  OR NEW.total_minor IS NOT OLD.total_minor
  OR NEW.captured_minor IS NOT OLD.captured_minor
  OR NEW.stripe_event_id IS NOT OLD.stripe_event_id
  OR NEW.paid_at IS NOT OLD.paid_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'order financial identity is immutable');
END;

-- An order's tenant must be the tenant of the checkout it was made from. The
-- foreign key points at a global primary key and is satisfied by ANY tenant's
-- checkout, exactly the gap checkout_items closes against products. Without
-- this, a webhook bug or a repair script could file tenant B's paid order under
-- tenant A, where tenant A's admin would read it.
CREATE TRIGGER orders_tenant_matches_checkout_insert
BEFORE INSERT ON orders
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM checkouts AS parent WHERE parent.checkout_id = NEW.checkout_id
)
BEGIN
  SELECT RAISE(ABORT, 'order tenant_id must match checkout tenant_id');
END;

CREATE TRIGGER orders_tenant_matches_checkout_update
BEFORE UPDATE ON orders
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM checkouts AS parent WHERE parent.checkout_id = NEW.checkout_id
)
BEGIN
  SELECT RAISE(ABORT, 'order tenant_id must match checkout tenant_id');
END;

CREATE INDEX orders_tenant_created_idx ON orders(tenant_id, created_at DESC);
CREATE INDEX orders_tenant_status_idx ON orders(tenant_id, status);
CREATE INDEX orders_tenant_email_idx ON orders(tenant_id, customer_email);

-- The fulfilment manifest: what was bought, at the price it was bought for.
--
-- Copied from `checkout_items`, which 0007's snapshot trigger already froze. The
-- copy is not redundancy for its own sake — it is what lets an order be
-- fulfilled without reading mutable catalogue state, which is the invariant the
-- data model states plainly: "never recompute from current product/customer
-- docs". A product renamed, repriced, unpublished, or archived after payment
-- changes nothing here.
CREATE TABLE order_items (
  order_item_id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  -- Informational after creation, exactly as the data model requires: deleting a
  -- product must not break a historical order. They are still tenant-checked by
  -- trigger below, because a cross-tenant reference would be a leak whether or
  -- not it is authoritative.
  product_id TEXT NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  variant_id TEXT REFERENCES product_variants(variant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 1 AND quantity <= 999),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor = quantity * unit_price_minor),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (order_id, item_index)
);

CREATE TRIGGER order_items_tenant_immutable
BEFORE UPDATE OF tenant_id ON order_items
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER order_items_tenant_matches_order_insert
BEFORE INSERT ON order_items
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM orders AS parent WHERE parent.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'order item tenant_id must match order tenant_id');
END;

CREATE TRIGGER order_items_tenant_matches_order_update
BEFORE UPDATE ON order_items
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM orders AS parent WHERE parent.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'order item tenant_id must match order tenant_id');
END;

CREATE TRIGGER order_items_tenant_matches_product_insert
BEFORE INSERT ON order_items
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'order item tenant_id must match product tenant_id');
END;

CREATE TRIGGER order_items_tenant_matches_product_update
BEFORE UPDATE ON order_items
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'order item tenant_id must match product tenant_id');
END;

-- A paid line is frozen completely: unlike a checkout item, not one column of it
-- may move, because there is no legitimate edit to a line someone has paid for.
-- A correction is a refund plus a new order, both of which leave a trail.
CREATE TRIGGER order_items_snapshot_immutable
BEFORE UPDATE ON order_items
FOR EACH ROW
WHEN NEW.order_id IS NOT OLD.order_id
  OR NEW.item_index IS NOT OLD.item_index
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.variant_id IS NOT OLD.variant_id
  OR NEW.sku IS NOT OLD.sku
  OR NEW.name IS NOT OLD.name
  OR NEW.quantity IS NOT OLD.quantity
  OR NEW.unit_price_minor IS NOT OLD.unit_price_minor
  OR NEW.line_total_minor IS NOT OLD.line_total_minor
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'order item snapshots are immutable');
END;

CREATE INDEX order_items_order_idx ON order_items(order_id);

-- Append-only lifecycle log. The data model asks for it by name, and the reason
-- is operational: when a refund, a print transition, or a dispute moves an
-- order, the question "how did it get here" must be answerable from the record
-- rather than from log retention.
--
-- `from_status` is nullable because the first row has no predecessor — the
-- order's creation is a transition from nothing into 'paid'.
CREATE TABLE order_status_history (
  history_id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  -- Who or what caused it. NULL actor means the system acted — the webhook has
  -- no user, and inventing one would be a lie in an audit record.
  actor_user_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER order_status_history_append_only_update
BEFORE UPDATE ON order_status_history
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'order status history is append-only');
END;

CREATE TRIGGER order_status_history_append_only_delete
BEFORE DELETE ON order_status_history
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'order status history is append-only');
END;

CREATE TRIGGER order_status_history_tenant_matches_order_insert
BEFORE INSERT ON order_status_history
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM orders AS parent WHERE parent.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'order status history tenant_id must match order tenant_id');
END;

CREATE INDEX order_status_history_order_idx
  ON order_status_history(tenant_id, order_id, created_at);

-- The provider event ledger — the dedupe authority for webhook deliveries.
--
-- WHY THIS EXISTS AT ALL, given `orders.checkout_id` is already UNIQUE.
-- Production has no such table: its idempotency is entirely "the order document
-- id IS the PaymentIntent id", so a duplicate delivery collides on create() and
-- returns early. That works for order creation and for nothing else. The
-- consequence, visible in stripeWebhook.ts, is that a crash AFTER the order is
-- created but BEFORE the discount increment makes Stripe's retry short-circuit
-- at the existing-order check and the increment is permanently lost, with
-- nothing to reconcile it against.
--
-- Here the order insert, the checkout transition, the used_count increment and
-- this row all land in ONE `db.batch`, so that failure mode cannot arise: either
-- every effect happened or none did. This table adds the second property a
-- provider ledger gives you — a record of WHICH deliveries were seen, including
-- ones that produced no order (an unknown intent, a mismatched amount, an event
-- type nobody handles). Without it those are invisible, and "Stripe says it
-- delivered, we have nothing" is unanswerable.
--
-- `tenant_id` is nullable on purpose: an event can be recorded before — or
-- without — a tenant being known, which is exactly the case for a delivery
-- naming an intent no checkout claims. A tenant column that forced a guess
-- would be worse than an honest NULL.
CREATE TABLE payment_events (
  -- The provider's own event id (`evt_...`). PRIMARY KEY, so a replayed
  -- delivery is a UNIQUE violation rather than a second row. This is the
  -- structural half of "at most once per event"; the application's guarded
  -- read makes it a clean 200 no-op rather than an error.
  event_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('stripe')),
  event_type TEXT NOT NULL,
  -- The provider object the event was about (a PaymentIntent id here). Not
  -- unique: several event types legitimately concern one intent.
  object_id TEXT,
  -- What this worker did about it. 'processed' means effects landed;
  -- 'ignored' means the event was understood and deliberately produced none
  -- (an unhandled type, an intent no checkout claims); 'rejected' means it was
  -- understood and REFUSED (an amount that disagreed with the frozen total) —
  -- the state an operator must actually look at.
  outcome TEXT NOT NULL CHECK (outcome IN ('processed', 'ignored', 'rejected')),
  -- A short, enumerated reason. Deliberately a code, never provider text or a
  -- payload excerpt: this table is operational, and a webhook body carries buyer
  -- data that has no business being copied into a second place.
  reason_code TEXT,
  received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER payment_events_append_only_update
BEFORE UPDATE ON payment_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'payment events are append-only');
END;

CREATE TRIGGER payment_events_append_only_delete
BEFORE DELETE ON payment_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'payment events are append-only');
END;

CREATE INDEX payment_events_object_idx ON payment_events(object_id, created_at DESC);
CREATE INDEX payment_events_outcome_idx ON payment_events(outcome, created_at DESC);
