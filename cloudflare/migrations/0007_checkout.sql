PRAGMA foreign_keys = ON;

-- Server-authoritative checkout. Every monetary column here is computed by the
-- worker from the tenant's own publication/variant rows; nothing a client sends
-- ever reaches these columns. This is the pre-payment half of transaction
-- boundary 1 — the Stripe seam is payment_intent_id, still NULL at this stage.
CREATE TABLE checkouts (
  checkout_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Only 'open' is reachable today. 'expired'/'abandoned' belong to a later
  -- sweep and 'completed' to the payment checkpoint; the allowlist is declared
  -- now so those transitions land against a constrained column, not a free one.
  status TEXT NOT NULL CHECK (status IN ('open', 'expired', 'abandoned', 'completed')),
  -- Shape is validated app-side (single '@', bounded, no control bytes) and
  -- lowercased before it arrives. SQLite has no address grammar to enforce.
  customer_email TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  -- Shipping/VAT/discount engines do not exist yet, so these are always 0 for
  -- now. They exist at creation so the totals equation below is a real
  -- constraint from day one rather than a column added after money is stored.
  shipping_minor INTEGER NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
  vat_minor INTEGER NOT NULL DEFAULT 0 CHECK (vat_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  -- The Stripe seam. NULL until a PaymentIntent is created; unique when set so
  -- one intent can never be attached to two checkouts. SQLite treats NULLs as
  -- distinct in a UNIQUE index, so the nullable column stays freely repeatable.
  payment_intent_id TEXT UNIQUE,
  -- SHA-256 of "{tenant_id}:{caller key}". The raw caller key is never stored:
  -- it is a client-chosen capability-ish string and hashing keeps it out of the
  -- row while preserving exact-match replay detection.
  idempotency_key_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  -- The totals contract. Enforced in the schema so no future code path — a
  -- shipping engine, a discount engine, a manual repair — can persist a total
  -- that disagrees with its own components.
  CHECK (total_minor = subtotal_minor + shipping_minor + vat_minor - discount_minor),
  -- Idempotency keys are scoped per tenant: two storefronts may legitimately
  -- pick the same key, and neither may observe the other's checkout.
  UNIQUE (tenant_id, idempotency_key_hash)
);

CREATE TRIGGER checkouts_tenant_immutable
BEFORE UPDATE OF tenant_id ON checkouts
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE INDEX checkouts_tenant_status_idx ON checkouts(tenant_id, status);
CREATE INDEX checkouts_tenant_email_idx ON checkouts(tenant_id, customer_email);

-- Priced line snapshots. Product/variant foreign keys are informational after
-- creation: what the buyer was quoted is the sku/name/price frozen here, not
-- whatever the catalogue says later.
CREATE TABLE checkout_items (
  checkout_item_id TEXT PRIMARY KEY NOT NULL,
  checkout_id TEXT NOT NULL REFERENCES checkouts(checkout_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  product_id TEXT NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  variant_id TEXT REFERENCES product_variants(variant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 1 AND quantity <= 999),
  unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor = quantity * unit_price_minor),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (checkout_id, item_index)
);

CREATE TRIGGER checkout_items_tenant_immutable
BEFORE UPDATE OF tenant_id ON checkout_items
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER checkout_items_tenant_matches_checkout_insert
BEFORE INSERT ON checkout_items
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM checkouts AS parent WHERE parent.checkout_id = NEW.checkout_id
)
BEGIN
  SELECT RAISE(ABORT, 'checkout item tenant_id must match checkout tenant_id');
END;

CREATE TRIGGER checkout_items_tenant_matches_checkout_update
BEFORE UPDATE ON checkout_items
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM checkouts AS parent WHERE parent.checkout_id = NEW.checkout_id
)
BEGIN
  SELECT RAISE(ABORT, 'checkout item tenant_id must match checkout tenant_id');
END;

-- The product/variant foreign keys point at global primary keys, so the FK
-- alone is satisfied by ANY tenant's row. These triggers close that gap the
-- same way product_variants does against products: a priced line may only
-- reference catalogue rows the owning tenant actually holds. resolveLine
-- already filters by tenant, but the schema must not depend on it — a later
-- repair script or pricing engine writing directly here would otherwise
-- durably attach another tenant's product to a line that gets charged.
CREATE TRIGGER checkout_items_tenant_matches_product_insert
BEFORE INSERT ON checkout_items
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'checkout item tenant_id must match product tenant_id');
END;

CREATE TRIGGER checkout_items_tenant_matches_product_update
BEFORE UPDATE ON checkout_items
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'checkout item tenant_id must match product tenant_id');
END;

-- The variant is optional, so the guard only fires when one is present. It
-- checks tenancy AND parentage: a variant of a different product would let a
-- cheap line masquerade as an expensive product's price.
CREATE TRIGGER checkout_items_variant_matches_product_insert
BEFORE INSERT ON checkout_items
FOR EACH ROW
WHEN NEW.variant_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_variants AS variant
    WHERE variant.variant_id = NEW.variant_id
      AND variant.tenant_id = NEW.tenant_id
      AND variant.product_id = NEW.product_id
  )
BEGIN
  SELECT RAISE(ABORT, 'checkout item variant must belong to the same tenant and product');
END;

CREATE TRIGGER checkout_items_variant_matches_product_update
BEFORE UPDATE ON checkout_items
FOR EACH ROW
WHEN NEW.variant_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_variants AS variant
    WHERE variant.variant_id = NEW.variant_id
      AND variant.tenant_id = NEW.tenant_id
      AND variant.product_id = NEW.product_id
  )
BEGIN
  SELECT RAISE(ABORT, 'checkout item variant must belong to the same tenant and product');
END;

-- The priced snapshot is frozen at creation. A later price change, rename, or
-- quantity edit must create a new checkout, never mutate what was quoted: the
-- payment checkpoint will charge against these numbers.
CREATE TRIGGER checkout_items_snapshot_immutable
BEFORE UPDATE ON checkout_items
FOR EACH ROW
WHEN NEW.sku IS NOT OLD.sku
  OR NEW.name IS NOT OLD.name
  OR NEW.unit_price_minor IS NOT OLD.unit_price_minor
  OR NEW.quantity IS NOT OLD.quantity
  OR NEW.line_total_minor IS NOT OLD.line_total_minor
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.variant_id IS NOT OLD.variant_id
BEGIN
  SELECT RAISE(ABORT, 'checkout item snapshots are immutable');
END;

CREATE INDEX checkout_items_checkout_idx ON checkout_items(checkout_id);
