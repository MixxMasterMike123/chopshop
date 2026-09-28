PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP4-R — the recipient of an order (DECISIONS D98).
--
-- Until this migration the checkout took the buyer's e-mail address, the
-- delivery method and the country, and nothing else: no table held a name, a
-- street address, a postal code, a city, a telephone number, a pickup place or
-- a pickup date, so a shop could take a payment and not know where to deliver.
--
-- checkout_recipients  ONE row per checkout: who gets it and where, validated
--                      and frozen by POST /v1/checkout in the batch that
--                      creates the checkout (src/commerce/recipient.ts). Part
--                      of what the idempotency key stands for.
-- order_recipients     ONE row per order: copied from the checkout's row in
--                      the batch that creates the order (the payment
--                      provider's confirmation, src/commerce/webhook.ts). An
--                      order whose checkout has no row (every order made
--                      before 0045) has none, and is read with recipient null.
--
-- WHY TABLES OF THEIR OWN, NOT COLUMNS (D68): the order is permanent evidence
-- and cannot change (0011 orders_money_immutable); the recipient is personal
-- data and must be removable one day without touching the order. A DELETE is
-- therefore allowed by the schema — and done by no route of this step (the
-- erasure route is D68's, still open).
--
-- A ROW IS NEVER UPDATED: a trigger refuses every UPDATE, and a second INSERT
-- for the same parent (plain, OR IGNORE or OR REPLACE — which would otherwise
-- delete the first row without firing a DELETE trigger) aborts before any
-- conflict resolution runs.
--
-- The shape, per delivery method (CHECKed here, validated app-side first:
-- trimmed, no control character, no line break, the lengths below):
--   shipping  name, address_line1, address_line2?, postal_code, city,
--             country (= checkouts.shipping_country), phone?
--   pickup    name, phone?, pickup_location_id, pickup_date? — and the place's
--             name and address AS THEY WERE when the checkout was made
--             (pickup_location_name / _address, copied from the shop's store
--             identity), so a later edit of the shop's settings does not
--             change where an order said it would be collected.
-- `delivery_method` repeats the parent's, which a trigger enforces: the CHECKs
-- can then pin which columns a row of each kind may carry.
--
-- The texts are stored as given (after trimming) and are TEXT wherever they are
-- shown: nothing here is HTML.
--
-- NOTHING OF A RECIPIENT is written to a log line, an audit event, an alert or
-- an outbox payload: those carry ids only.
--
-- TIME: ISO-8601 UTC TEXT written by the server (PLAN §2.8), the round-trip
-- CHECK of 0044.
-- ============================================================================

CREATE TABLE checkout_recipients (
  checkout_id TEXT PRIMARY KEY NOT NULL REFERENCES checkouts(checkout_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('shipping', 'pickup')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  phone TEXT CHECK (phone IS NULL OR (length(phone) BETWEEN 1 AND 30 AND phone NOT GLOB '*[^0-9 +()-]*')),
  address_line1 TEXT CHECK (address_line1 IS NULL OR length(address_line1) BETWEEN 1 AND 100),
  address_line2 TEXT CHECK (address_line2 IS NULL OR length(address_line2) BETWEEN 1 AND 100),
  postal_code TEXT CHECK (postal_code IS NULL OR length(postal_code) BETWEEN 1 AND 16),
  city TEXT CHECK (city IS NULL OR length(city) BETWEEN 1 AND 100),
  country TEXT CHECK (country IS NULL OR (length(country) = 2 AND country NOT GLOB '*[^A-Z]*')),
  pickup_location_id TEXT CHECK (pickup_location_id IS NULL OR length(pickup_location_id) BETWEEN 1 AND 128),
  pickup_location_name TEXT CHECK (pickup_location_name IS NULL OR length(pickup_location_name) BETWEEN 1 AND 200),
  pickup_location_address TEXT CHECK (pickup_location_address IS NULL OR length(pickup_location_address) BETWEEN 1 AND 500),
  pickup_date TEXT CHECK (pickup_date IS NULL OR (length(pickup_date) = 10 AND pickup_date IS date(pickup_date))),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  -- No line break in any one-line text.
  CHECK (instr(name, char(10)) = 0 AND instr(name, char(13)) = 0),
  CHECK (address_line1 IS NULL OR (instr(address_line1, char(10)) = 0 AND instr(address_line1, char(13)) = 0)),
  CHECK (address_line2 IS NULL OR (instr(address_line2, char(10)) = 0 AND instr(address_line2, char(13)) = 0)),
  CHECK (city IS NULL OR (instr(city, char(10)) = 0 AND instr(city, char(13)) = 0)),
  CHECK (postal_code IS NULL OR (instr(postal_code, char(10)) = 0 AND instr(postal_code, char(13)) = 0)),
  -- A shipped parcel has an address and no pickup place; a collected one the
  -- reverse.
  CHECK (
    (delivery_method = 'shipping'
      AND address_line1 IS NOT NULL AND postal_code IS NOT NULL
      AND city IS NOT NULL AND country IS NOT NULL
      AND pickup_location_id IS NULL AND pickup_location_name IS NULL
      AND pickup_location_address IS NULL AND pickup_date IS NULL)
    OR
    (delivery_method = 'pickup'
      AND pickup_location_id IS NOT NULL
      AND address_line1 IS NULL AND address_line2 IS NULL AND postal_code IS NULL
      AND city IS NULL AND country IS NULL)
  )
);

-- The tenant, the delivery method and (for a parcel) the country are the
-- checkout's own: a recipient can never be attached to another shop's checkout,
-- nor say a different thing than the priced checkout does.
CREATE TRIGGER checkout_recipients_matches_checkout_insert
BEFORE INSERT ON checkout_recipients
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM checkouts AS parent
  WHERE parent.checkout_id = NEW.checkout_id
    AND parent.tenant_id = NEW.tenant_id
    AND parent.delivery_method = NEW.delivery_method
    AND (NEW.delivery_method = 'pickup' OR parent.shipping_country IS NEW.country)
)
BEGIN
  SELECT RAISE(ABORT, 'checkout recipient must match its checkout (tenant, delivery method, country)');
END;

CREATE TRIGGER checkout_recipients_insert_once
BEFORE INSERT ON checkout_recipients
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM checkout_recipients WHERE checkout_id = NEW.checkout_id)
BEGIN
  SELECT RAISE(ABORT, 'checkout recipients are never replaced');
END;

CREATE TRIGGER checkout_recipients_no_update
BEFORE UPDATE ON checkout_recipients
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'checkout recipients are never updated');
END;

CREATE INDEX checkout_recipients_tenant_idx ON checkout_recipients(tenant_id, checkout_id);

CREATE TABLE order_recipients (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('shipping', 'pickup')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  phone TEXT CHECK (phone IS NULL OR (length(phone) BETWEEN 1 AND 30 AND phone NOT GLOB '*[^0-9 +()-]*')),
  address_line1 TEXT CHECK (address_line1 IS NULL OR length(address_line1) BETWEEN 1 AND 100),
  address_line2 TEXT CHECK (address_line2 IS NULL OR length(address_line2) BETWEEN 1 AND 100),
  postal_code TEXT CHECK (postal_code IS NULL OR length(postal_code) BETWEEN 1 AND 16),
  city TEXT CHECK (city IS NULL OR length(city) BETWEEN 1 AND 100),
  country TEXT CHECK (country IS NULL OR (length(country) = 2 AND country NOT GLOB '*[^A-Z]*')),
  pickup_location_id TEXT CHECK (pickup_location_id IS NULL OR length(pickup_location_id) BETWEEN 1 AND 128),
  pickup_location_name TEXT CHECK (pickup_location_name IS NULL OR length(pickup_location_name) BETWEEN 1 AND 200),
  pickup_location_address TEXT CHECK (pickup_location_address IS NULL OR length(pickup_location_address) BETWEEN 1 AND 500),
  pickup_date TEXT CHECK (pickup_date IS NULL OR (length(pickup_date) = 10 AND pickup_date IS date(pickup_date))),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  CHECK (instr(name, char(10)) = 0 AND instr(name, char(13)) = 0),
  CHECK (address_line1 IS NULL OR (instr(address_line1, char(10)) = 0 AND instr(address_line1, char(13)) = 0)),
  CHECK (address_line2 IS NULL OR (instr(address_line2, char(10)) = 0 AND instr(address_line2, char(13)) = 0)),
  CHECK (city IS NULL OR (instr(city, char(10)) = 0 AND instr(city, char(13)) = 0)),
  CHECK (postal_code IS NULL OR (instr(postal_code, char(10)) = 0 AND instr(postal_code, char(13)) = 0)),
  CHECK (
    (delivery_method = 'shipping'
      AND address_line1 IS NOT NULL AND postal_code IS NOT NULL
      AND city IS NOT NULL AND country IS NOT NULL
      AND pickup_location_id IS NULL AND pickup_location_name IS NULL
      AND pickup_location_address IS NULL AND pickup_date IS NULL)
    OR
    (delivery_method = 'pickup'
      AND pickup_location_id IS NOT NULL
      AND address_line1 IS NULL AND address_line2 IS NULL AND postal_code IS NULL
      AND city IS NULL AND country IS NULL)
  )
);

CREATE TRIGGER order_recipients_matches_order_insert
BEFORE INSERT ON order_recipients
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM orders AS parent
  WHERE parent.order_id = NEW.order_id
    AND parent.tenant_id = NEW.tenant_id
    AND parent.delivery_method = NEW.delivery_method
    AND (NEW.delivery_method = 'pickup' OR parent.shipping_country IS NEW.country)
)
BEGIN
  SELECT RAISE(ABORT, 'order recipient must match its order (tenant, delivery method, country)');
END;

CREATE TRIGGER order_recipients_insert_once
BEFORE INSERT ON order_recipients
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM order_recipients WHERE order_id = NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'order recipients are never replaced');
END;

CREATE TRIGGER order_recipients_no_update
BEFORE UPDATE ON order_recipients
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'order recipients are never updated');
END;

CREATE INDEX order_recipients_tenant_idx ON order_recipients(tenant_id, order_id);
