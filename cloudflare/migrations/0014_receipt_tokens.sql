PRAGMA foreign_keys = ON;

-- The guest receipt capability (PLAN §2.1, §2.3).
--
-- A guest buyer has no account, so the right to read their own order is a
-- bearer capability: a 256-bit random token, minted by the Stripe webhook in the
-- SAME batch that creates the order, stored here only as its SHA-256, bound to
-- one tenant and one order, and valid for 30 days. `GET /v1/orders/:orderId`
-- with `Authorization: Bearer <token>` answers only when hostname tenant, order
-- id and token hash all match and the expiry has not passed.
--
-- TIME: ISO-8601 UTC TEXT written by the server (PLAN §2.8). Same canonical
-- shape and the same strftime round-trip CHECK as 0013_acting_as.sql, for the
-- same reason: the expiry is compared lexicographically.
ALTER TABLE orders ADD COLUMN receipt_token_hash TEXT CHECK (
  receipt_token_hash IS NULL
  OR (
    length(receipt_token_hash) = 64
    AND receipt_token_hash NOT GLOB '*[^0-9a-f]*'
  )
);

ALTER TABLE orders ADD COLUMN receipt_token_expires_at TEXT CHECK (
  receipt_token_expires_at IS NULL
  OR receipt_token_expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', receipt_token_expires_at)
);

-- A hash without an expiry would be a capability that never ends; an expiry
-- without a hash is meaningless. Table-level CHECKs cannot be added by ALTER, so
-- the pairing is enforced by trigger on both write paths.
CREATE TRIGGER orders_receipt_token_paired_insert
BEFORE INSERT ON orders
FOR EACH ROW
WHEN (NEW.receipt_token_hash IS NULL) IS NOT (NEW.receipt_token_expires_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'receipt token hash and expiry must be set together');
END;

CREATE TRIGGER orders_receipt_token_paired_update
BEFORE UPDATE OF receipt_token_hash, receipt_token_expires_at ON orders
FOR EACH ROW
WHEN (NEW.receipt_token_hash IS NULL) IS NOT (NEW.receipt_token_expires_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'receipt token hash and expiry must be set together');
END;

-- The lookup the receipt read makes: tenant first, as every tenant index.
CREATE INDEX orders_tenant_receipt_token_idx
  ON orders(tenant_id, receipt_token_hash);

-- ONE-TIME HANDOFF of the raw token to the buyer's browser.
--
-- The order is created by the webhook, which has no browser to answer, so the
-- raw token cannot be returned where it is minted. It is parked here, keyed by
-- the checkout the browser already holds (the same bearer capability the payment
-- route runs on), and the confirmation poll takes it with ONE statement —
-- `DELETE … RETURNING` — so exactly one poll ever receives it and the raw value
-- stops existing at that moment. What stays behind is only the hash on the
-- order.
--
-- A row nobody collects expires after one hour and is swept; the raw token is
-- therefore at rest for at most that long, and only for an order whose buyer
-- never reached the confirmation page.
CREATE TABLE order_receipt_handoffs (
  checkout_id TEXT PRIMARY KEY NOT NULL REFERENCES checkouts(checkout_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- base64url of 32 random bytes, unpadded: exactly 43 characters.
  receipt_token TEXT NOT NULL CHECK (
    length(receipt_token) = 43
    AND receipt_token NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  expires_at TEXT NOT NULL CHECK (
    expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)
  ),
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  ),
  CHECK (expires_at > created_at)
);

CREATE TRIGGER order_receipt_handoffs_tenant_immutable
BEFORE UPDATE OF tenant_id ON order_receipt_handoffs
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- A handoff is written once and taken once. There is no legitimate update.
CREATE TRIGGER order_receipt_handoffs_no_update
BEFORE UPDATE ON order_receipt_handoffs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'receipt handoffs are write-once');
END;

-- The handoff belongs to the tenant of the order it hands off.
CREATE TRIGGER order_receipt_handoffs_tenant_matches_order
BEFORE INSERT ON order_receipt_handoffs
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM orders AS parent WHERE parent.order_id = NEW.order_id
)
  OR NEW.checkout_id IS NOT (
  SELECT parent.checkout_id FROM orders AS parent WHERE parent.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'receipt handoff must match its order');
END;

CREATE INDEX order_receipt_handoffs_tenant_created_idx
  ON order_receipt_handoffs(tenant_id, created_at);
CREATE INDEX order_receipt_handoffs_expiry_idx
  ON order_receipt_handoffs(expires_at);
