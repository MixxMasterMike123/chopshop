PRAGMA foreign_keys = ON;

-- Totals contract v2: VAT is CONTAINED IN the total, not added to it.
--
-- 0007 encoded `total = subtotal + shipping + vat - discount`, which is
-- VAT-EXCLUSIVE arithmetic. Production is the opposite: every catalogue price
-- is SEK VAT-inclusive (see functions/src/payment/createPaymentIntent.ts,
-- computeOrderTotalsSek), so the charge is
--
--   total = subtotal + shipping - discount
--   vat   = total - total / (1 + rate)      -- derived, informational only
--
-- Leaving the 0007 CHECK in place would have forced every future writer to
-- store vat_minor = 0 in order to satisfy it, quietly discarding the only
-- number an invoice needs. SQLite cannot ALTER a CHECK, so `checkouts` is
-- recreated below.
--
-- RECREATE ORDER — why both tables are rebuilt, not just `checkouts`:
--
-- Three properties of this D1 instance were verified by probe rather than
-- assumed, and each rules out the shorter recipes:
--
--   1. `PRAGMA foreign_keys` is 1 and `PRAGMA defer_foreign_keys = true` does
--      NOT persist. Each D1 statement runs in its own implicit transaction and
--      SQLite resets defer_foreign_keys at every commit, so the pragma is
--      already back to 0 by the time the next statement runs. The documented
--      "defer FKs across a recreate" recipe is therefore unavailable here.
--   2. Consequently `DROP TABLE checkouts` fails outright (SQLITE_CONSTRAINT_
--      FOREIGNKEY) whenever any `checkout_items` row references it.
--   3. `PRAGMA legacy_alter_table` is 0 and also does not persist, so
--      `ALTER TABLE checkouts RENAME TO checkouts_old` REWRITES the child's
--      foreign key to point at `checkouts_old`. That is the dangerous variant:
--      it succeeds silently and leaves `checkout_items` referencing a table
--      this migration is about to drop, or worse, a surviving legacy one.
--
-- So the only sound sequence is to rebuild the child too: snapshot both tables
-- into plain staging copies (no FKs, no triggers, so they cannot participate in
-- constraint enforcement), drop child then parent, create the new parent, copy
-- its rows, create the new child, copy its rows, drop the staging copies, and
-- re-declare every trigger and index. Verified locally: the sequence completes,
-- rows survive, `PRAGMA foreign_key_check` returns empty, and the re-declared
-- triggers fire.
--
-- ROW MAPPING — why the old→new copy is sound rather than a guess:
--
-- Under 0007 no code path could ever write a non-zero shipping/vat/discount:
-- createCheckout hard-coded `0, 0, 0` and the totals CHECK pinned
-- `total = subtotal + 0 + 0 - 0`. Every existing row therefore satisfies the v2
-- contract `total = subtotal + shipping - discount` already, unchanged and
-- unrecomputed. What the old rows genuinely lack is the new dimensions, which
-- are backfilled with the values that describe what those checkouts actually
-- were: they were all quoted with no shipping engine (delivery_method
-- 'shipping', shipping_minor 0), for a Swedish storefront (shipping_country
-- 'SE'), under the Swedish standard rate (vat_rate_bp 2500). vat_minor is
-- recomputed from the frozen rate with the same round-half-up integer formula
-- the worker uses, so a historical row reports the same VAT a fresh quote of
-- the same total would.
--
-- Staging currently holds no tenants at all and every live checkout probe
-- 404'd, so this copy path is expected to move zero rows. It is written anyway:
-- a migration that would silently destroy data if the assumption were wrong is
-- not a migration worth running.

CREATE TABLE checkouts_migration_0009 AS SELECT * FROM checkouts;
CREATE TABLE checkout_items_migration_0009 AS SELECT * FROM checkout_items;

DROP TABLE checkout_items;
DROP TABLE checkouts;

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
  -- How the basket leaves the shop. This is not a display preference: 'pickup'
  -- zeroes shipping, so it is a priced decision and belongs under a CHECK.
  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('shipping', 'pickup')),
  -- The destination country, uppercase ISO-3166-1 alpha-2, and the input to the
  -- shipping region table. Meaningful only for a shipped basket: a pickup order
  -- has no destination, and storing one would invite a later reader to price
  -- shipping against a basket that was never going to be shipped. The
  -- equivalence below states both directions at once — pickup implies no
  -- country AND a missing country implies pickup — so neither combination can
  -- be written by any future code path.
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
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  shipping_minor INTEGER NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
  -- Derived and informational: the VAT already contained in total_minor at the
  -- tenant's rate. It is NOT a component of the total, which is why it appears
  -- in no totals equation below — only in the containment bound.
  vat_minor INTEGER NOT NULL DEFAULT 0,
  -- The rate used at quote time, in basis points, frozen on the row. The
  -- tenant's rate can change tomorrow; what this buyer was quoted under cannot.
  -- Without this an auditor could not reproduce vat_minor from the total.
  vat_rate_bp INTEGER NOT NULL CHECK (vat_rate_bp >= 0 AND vat_rate_bp <= 10000),
  -- Discount engine is a later checkpoint; the column exists so the totals
  -- equation is a real constraint from day one rather than one added after
  -- money is stored.
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
  -- The totals contract, v2. Prices are VAT-inclusive, so VAT is absent here by
  -- design: adding it would double-count the tax already inside subtotal.
  -- Enforced in the schema so no future code path — a discount engine, a manual
  -- repair — can persist a total that disagrees with its own components.
  CHECK (total_minor = subtotal_minor + shipping_minor - discount_minor),
  -- VAT is contained in the total. Zero is legitimate (a zero-rated tenant, or
  -- a zero total); more than the total is arithmetically impossible for any
  -- rate in [0, 100%] and would mean the derivation broke.
  CHECK (vat_minor >= 0 AND vat_minor <= total_minor),
  -- A collected basket ships nothing, so it is never charged carriage. The
  -- worker enforces this too; the schema is what makes it true for every writer.
  CHECK (delivery_method <> 'pickup' OR shipping_minor = 0),
  -- Idempotency keys are scoped per tenant: two storefronts may legitimately
  -- pick the same key, and neither may observe the other's checkout.
  UNIQUE (tenant_id, idempotency_key_hash)
);

-- Historical rows, mapped as documented above. Rows written under 0007 all have
-- shipping = vat = discount = 0, so total already equals subtotal and no money
-- column is recomputed here; only the new dimensions are supplied. vat_minor is
-- derived with the same round-half-up integer formula the worker uses:
--   vat = total - round(total * 10000 / (10000 + rate_bp))
-- expressed with integer division as (2*n + d) / (2*d) to avoid any float.
--
-- The CAST is not decorative. SQLite's `/` is integer division only when BOTH
-- operands are integers, and it was verified locally that a value arriving as
-- REAL turns the whole expression into float arithmetic (a bound JS number does
-- exactly that). total_minor is a declared INTEGER column so this reads as an
-- integer already, but the CAST makes the operator's behaviour a property of
-- this statement rather than of the column's storage class.
INSERT INTO checkouts (
  checkout_id, tenant_id, status, customer_email, currency,
  delivery_method, shipping_country, subtotal_minor, shipping_minor,
  vat_minor, vat_rate_bp, discount_minor, total_minor, payment_intent_id,
  idempotency_key_hash, expires_at, created_at, updated_at
)
SELECT
  checkout_id,
  tenant_id,
  status,
  customer_email,
  currency,
  'shipping',
  'SE',
  subtotal_minor,
  shipping_minor,
  CAST(total_minor AS INTEGER)
    - ((2 * CAST(total_minor AS INTEGER) * 10000 + 12500) / 25000),
  2500,
  discount_minor,
  total_minor,
  payment_intent_id,
  idempotency_key_hash,
  expires_at,
  created_at,
  updated_at
FROM checkouts_migration_0009;

CREATE TRIGGER checkouts_tenant_immutable
BEFORE UPDATE OF tenant_id ON checkouts
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE INDEX checkouts_tenant_status_idx ON checkouts(tenant_id, status);
CREATE INDEX checkouts_tenant_email_idx ON checkouts(tenant_id, customer_email);

-- Recreated byte-for-byte from 0007. The child was only dropped so the parent
-- could be, and it is the same table with the same constraints; every trigger
-- and index below is a verbatim re-declaration, not a redesign. A silent loss
-- of any of them here would be a tenancy regression, which is why the test
-- suite re-proves each one after this migration rather than trusting the copy.
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

INSERT INTO checkout_items (
  checkout_item_id, checkout_id, tenant_id, item_index, product_id,
  variant_id, sku, name, quantity, unit_price_minor, line_total_minor,
  created_at, updated_at
)
SELECT
  checkout_item_id, checkout_id, tenant_id, item_index, product_id,
  variant_id, sku, name, quantity, unit_price_minor, line_total_minor,
  created_at, updated_at
FROM checkout_items_migration_0009;

DROP TABLE checkout_items_migration_0009;
DROP TABLE checkouts_migration_0009;

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
-- reference catalogue rows the owning tenant actually holds.
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

-- The tenant's VAT rate in basis points. 2500 (25%) is the Swedish standard
-- rate and the only rate production has ever applied (commerceConfig.vatRate).
-- A constant DEFAULT is what makes ADD COLUMN legal here, and it is also the
-- honest value for every tenant that exists: they were all quoted at 25%.
ALTER TABLE tenants ADD COLUMN vat_rate_bp INTEGER NOT NULL DEFAULT 2500
  CHECK (vat_rate_bp >= 0 AND vat_rate_bp <= 10000);

-- Shipping inputs, canonical product fields. These are deliberately NOT
-- projected into product_publications: the storefront has no business reading a
-- carton weight, and the checkout engine reads the canonical row it already
-- joins for tenancy.

-- Grams. The ceiling is one tonne, which no parcel a storefront ships will
-- approach, and which keeps `weight_grams * quantity` summed over 50 lines of
-- 999 far inside the safe-integer range.
ALTER TABLE products ADD COLUMN weight_grams INTEGER NOT NULL DEFAULT 0
  CHECK (weight_grams >= 0 AND weight_grams <= 1000000);

-- Per-product delivery eligibility, mirroring production's `delivery.shipping`
-- / `delivery.pickup` flags. Shipping defaults ON and pickup defaults OFF: a
-- shop that has not configured a pickup point cannot honour a collected order,
-- and defaulting pickup on would let a buyer zero the carriage on a product the
-- merchant never agreed to hand over in person.
ALTER TABLE products ADD COLUMN allow_shipping INTEGER NOT NULL DEFAULT 1
  CHECK (allow_shipping IN (0, 1));
ALTER TABLE products ADD COLUMN allow_pickup INTEGER NOT NULL DEFAULT 0
  CHECK (allow_pickup IN (0, 1));

-- Per-region carriage costs as JSON: {"sweden":{"cost":2900}, ...}, minor units
-- and VAT-inclusive like every other price here. SQLite cannot express that
-- shape, so it is validated app-side on write AND re-validated on read; a
-- malformed blob is treated as absent rather than trusted, so a corrupt row
-- degrades to the fallback tariff instead of pricing carriage from garbage.
ALTER TABLE products ADD COLUMN shipping_json TEXT;
