PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP5-WB — the fulfilment of an order, kept apart from its money.
--
-- WHY A COLUMN OF ITS OWN. `orders.status` (0011) holds both kinds of fact in
-- one vocabulary: 'paid' / 'partially_refunded' / 'refunded' are money,
-- 'processing' … 'completed' are fulfilment. The refund settlement
-- (src/commerce/refunds.ts STATUS_AFTER_REFUND_SQL) moves `status` to
-- 'refunded' on a full refund whatever it was, so a refund of a shipped order
-- would ERASE that it was shipped; and a seller writing 'shipped' into
-- `status` would erase 'partially_refunded'. From this migration on:
--   orders.status             the money path's, and only the money path's
--                             (webhook, refunds); no fulfilment route writes it
--   orders.fulfilment_status  the seller's fulfilment, written only by
--                             POST /v1/admin/orders/:orderId/fulfilment
--                             (src/commerce/fulfilment.ts); no money path
--                             writes it
-- Both facts now live side by side and neither can erase the other.
--
-- BACKFILL. An order whose `status` is a fulfilment value keeps that fact in
-- the new column: processing / printed → 'processing' ('printed' is not in the
-- seller's vocabulary: the order is being made), shipped → 'shipped' (a parcel
-- only), ready_for_pickup → 'ready_for_pickup' (a pickup only), delivered →
-- 'delivered', completed → 'completed'. A 'shipped' pickup order or a
-- 'ready_for_pickup' parcel (no code ever wrote either) becomes 'processing'.
-- Every other order ('paid', 'partially_refunded', 'refunded', 'cancelled')
-- takes the default 'unfulfilled'. `status` itself is NOT rewritten: it is the
-- money path's, and the cancellation's return case reads both columns
-- (src/dispatch/cancellation.ts).
--
-- THE HISTORY. `order_status_history` (0011, append-only) gains `track`: every
-- row written before 0046, and every row the webhook and the refunds write
-- (they do not name the column), is 'payment'; a fulfilment change writes
-- 'fulfilment'. A fulfilment row also carries the request's Idempotency-Key and
-- a hash of the request, so a retried request answers with the recorded change
-- (the refund route's rule, CP2-E).
--
-- THE SHIPMENTS. `order_shipments`: one row per 'shipped' change, with the
-- tracking number and the carrier when the seller gave them. Append-only: no
-- UPDATE, no DELETE, and a second INSERT with the same id or the same history
-- row (plain, OR IGNORE or OR REPLACE — which would delete the first row
-- without firing a DELETE trigger) aborts before conflict resolution runs.
--
-- TIME: `orders` and `order_status_history` keep their integer milliseconds;
-- the new table's `created_at` is ISO-8601 UTC text written by the server
-- (PLAN §2.8, the round-trip CHECK of 0044/0045).
-- ============================================================================

ALTER TABLE orders ADD COLUMN fulfilment_status TEXT NOT NULL DEFAULT 'unfulfilled'
  CHECK (fulfilment_status IN (
    'unfulfilled', 'processing', 'shipped', 'ready_for_pickup', 'delivered', 'completed'
  ));

UPDATE orders
SET fulfilment_status = CASE
    WHEN status IN ('processing', 'printed') THEN 'processing'
    WHEN status = 'shipped' AND delivery_method = 'shipping' THEN 'shipped'
    WHEN status = 'ready_for_pickup' AND delivery_method = 'pickup' THEN 'ready_for_pickup'
    WHEN status IN ('shipped', 'ready_for_pickup') THEN 'processing'
    WHEN status = 'delivered' THEN 'delivered'
    -- the WHERE leaves only 'completed' here
    ELSE 'completed'
  END
WHERE status IN ('processing', 'printed', 'shipped', 'ready_for_pickup', 'delivered', 'completed');

-- A parcel is shipped, a collected order is made ready for pickup; never the
-- reverse. And no order goes back to "nothing happened".
CREATE TRIGGER orders_fulfilment_coherent
BEFORE UPDATE OF fulfilment_status ON orders
FOR EACH ROW
WHEN (NEW.fulfilment_status = 'shipped' AND NEW.delivery_method <> 'shipping')
  OR (NEW.fulfilment_status = 'ready_for_pickup' AND NEW.delivery_method <> 'pickup')
  OR (OLD.fulfilment_status <> 'unfulfilled' AND NEW.fulfilment_status = 'unfulfilled')
BEGIN
  SELECT RAISE(ABORT, 'order fulfilment transition is not allowed');
END;

CREATE INDEX orders_tenant_fulfilment_idx
  ON orders(tenant_id, fulfilment_status, created_at DESC);

-- ── order_status_history: the track, and the fulfilment request's key ──────

ALTER TABLE order_status_history ADD COLUMN track TEXT NOT NULL DEFAULT 'payment'
  CHECK (track IN ('payment', 'fulfilment'));

ALTER TABLE order_status_history ADD COLUMN client_key TEXT CHECK (
  client_key IS NULL
  OR (length(client_key) = 36 AND client_key NOT GLOB '*[^0-9a-f-]*')
);

ALTER TABLE order_status_history ADD COLUMN request_hash TEXT CHECK (
  request_hash IS NULL
  OR (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*')
);

-- One fulfilment change per key and shop: the structural half of the route's
-- idempotency (two concurrent requests with one key: one batch commits, the
-- other aborts whole on this index and replays the winner).
CREATE UNIQUE INDEX order_status_history_client_key_idx
  ON order_status_history(tenant_id, client_key)
  WHERE client_key IS NOT NULL;

-- A fulfilment row speaks the fulfilment vocabulary, names where it came from,
-- and carries its key; a payment row carries neither key nor hash.
CREATE TRIGGER order_status_history_track_shape
BEFORE INSERT ON order_status_history
FOR EACH ROW
WHEN (NEW.track = 'fulfilment' AND (
        NEW.from_status IS NULL
        OR NEW.from_status NOT IN (
          'unfulfilled', 'processing', 'shipped', 'ready_for_pickup', 'delivered', 'completed'
        )
        OR NEW.to_status NOT IN (
          'processing', 'shipped', 'ready_for_pickup', 'delivered', 'completed'
        )
        OR NEW.client_key IS NULL
        OR NEW.request_hash IS NULL
      ))
  OR (NEW.track = 'payment' AND (NEW.client_key IS NOT NULL OR NEW.request_hash IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'order status history row does not match its track');
END;

-- ── order_shipments ────────────────────────────────────────────────────────

CREATE TABLE order_shipments (
  shipment_id TEXT PRIMARY KEY NOT NULL CHECK (length(shipment_id) BETWEEN 1 AND 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The 'shipped' change this shipment was recorded with (the e-mail consumer
  -- reads the tracking number through it; the outbox payload carries ids only).
  history_id TEXT NOT NULL UNIQUE
    REFERENCES order_status_history(history_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tracking_number TEXT CHECK (
    tracking_number IS NULL
    OR (length(tracking_number) BETWEEN 1 AND 100
        AND instr(tracking_number, char(10)) = 0 AND instr(tracking_number, char(13)) = 0)
  ),
  carrier TEXT CHECK (
    carrier IS NULL
    OR (length(carrier) BETWEEN 1 AND 60
        AND instr(carrier, char(10)) = 0 AND instr(carrier, char(13)) = 0)
  ),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  -- The user who recorded it. Never sent to a client (the order read says only
  -- what kind of actor changed the order, in its status history).
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 255)
);

-- The tenant is the order's, the order is a parcel, and the history row is a
-- fulfilment row of the same order.
CREATE TRIGGER order_shipments_matches_order_insert
BEFORE INSERT ON order_shipments
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM orders AS parent
  WHERE parent.order_id = NEW.order_id
    AND parent.tenant_id = NEW.tenant_id
    AND parent.delivery_method = 'shipping'
)
OR NOT EXISTS (
  SELECT 1 FROM order_status_history AS h
  WHERE h.history_id = NEW.history_id
    AND h.order_id = NEW.order_id
    AND h.tenant_id = NEW.tenant_id
    AND h.track = 'fulfilment'
    AND h.to_status = 'shipped'
)
BEGIN
  SELECT RAISE(ABORT, 'order shipment must match its order and its history row');
END;

CREATE TRIGGER order_shipments_insert_once
BEFORE INSERT ON order_shipments
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM order_shipments
  WHERE shipment_id = NEW.shipment_id OR history_id = NEW.history_id
)
BEGIN
  SELECT RAISE(ABORT, 'order shipments are never replaced');
END;

CREATE TRIGGER order_shipments_no_update
BEFORE UPDATE ON order_shipments
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'order shipments are append-only');
END;

CREATE TRIGGER order_shipments_no_delete
BEFORE DELETE ON order_shipments
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'order shipments are append-only');
END;

CREATE INDEX order_shipments_order_idx
  ON order_shipments(tenant_id, order_id, created_at);
