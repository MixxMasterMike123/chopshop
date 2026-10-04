PRAGMA foreign_keys = ON;

-- 0055 — Rabattkoder on Cloudflare (CP8-DC). A code's use is HELD while a
-- buyer is paying and COUNTED when the payment succeeds. The counter stays
-- discount_codes.used_count (the webhook's, 0010). A hold is one row per
-- checkout that froze a discount.
--
-- WHY A HOLD AND NOT A CAP CHECK ON THE COUNTER. The webhook must never fail
-- for a paid intent (src/commerce/webhook.ts header). A CHECK such as
-- used_count <= max_uses would abort the order batch of a buyer who paid
-- after their hold expired. So the cap is enforced where refusing is
-- harmless: at the INSERT of a hold, when nobody has paid yet.

CREATE TABLE discount_code_holds (
  hold_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  discount_code_id TEXT NOT NULL REFERENCES discount_codes(discount_code_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  checkout_id TEXT NOT NULL UNIQUE REFERENCES checkouts(checkout_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- sha256 hex of `${tenant_id}:${customer_email}`, the email as the checkout
  -- parser lowercased it. One buyer's several checkouts count as ONE hold for
  -- everyone else. No second copy of the address.
  buyer_key TEXT NOT NULL CHECK (length(buyer_key) = 64 AND buyer_key NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('held', 'released', 'used')),
  -- The order that used it. A breadcrumb with no foreign key, as
  -- checkouts.discount_code_id (0010): nothing on the webhook's path may abort.
  order_id TEXT,
  -- ms epoch. A hold counts while state = 'held' AND expires_at > now.
  -- Expiry needs no write.
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (expires_at > created_at),
  CHECK ((state = 'used') = (order_id IS NOT NULL))
);

CREATE TRIGGER discount_code_holds_tenant_immutable
BEFORE UPDATE OF tenant_id ON discount_code_holds
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER discount_code_holds_born_held
BEFORE INSERT ON discount_code_holds
FOR EACH ROW
WHEN NEW.state <> 'held' OR NEW.order_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a discount hold is born held');
END;

-- The hold belongs to a checkout of the same tenant that froze a discount
-- from THIS code, and lives no longer than that checkout.
CREATE TRIGGER discount_code_holds_match_checkout
BEFORE INSERT ON discount_code_holds
FOR EACH ROW
WHEN NOT EXISTS (
       SELECT 1 FROM checkouts AS c
       WHERE c.checkout_id = NEW.checkout_id
         AND c.tenant_id = NEW.tenant_id
         AND c.discount_code_id = NEW.discount_code_id
         AND c.discount_minor > 0
         AND c.expires_at >= NEW.expires_at)
  OR NOT EXISTS (
       SELECT 1 FROM discount_codes AS d
       WHERE d.discount_code_id = NEW.discount_code_id
         AND d.tenant_id = NEW.tenant_id)
BEGIN
  SELECT RAISE(ABORT, 'discount hold does not match its checkout');
END;

-- THE CAP. Uses counted (used_count) + live holds of OTHER buyers, each buyer
-- once. The same predicate as resolveDiscount's read
-- (src/commerce/discount-codes.ts). The message is matched by createCheckout
-- (isDiscountExhausted).
CREATE TRIGGER discount_code_holds_capacity
BEFORE INSERT ON discount_code_holds
FOR EACH ROW
WHEN (SELECT max_uses FROM discount_codes WHERE discount_code_id = NEW.discount_code_id) IS NOT NULL
  AND (SELECT used_count FROM discount_codes WHERE discount_code_id = NEW.discount_code_id)
      + (SELECT COUNT(DISTINCT h.buyer_key) FROM discount_code_holds AS h
         WHERE h.discount_code_id = NEW.discount_code_id
           AND h.state = 'held'
           AND h.expires_at > NEW.created_at
           AND h.buyer_key <> NEW.buyer_key)
      >= (SELECT max_uses FROM discount_codes WHERE discount_code_id = NEW.discount_code_id)
BEGIN
  SELECT RAISE(ABORT, 'discount code exhausted');
END;

-- held → released | used; released → used (a payment that succeeded after
-- its hold was released still counts). Nothing leaves 'used'.
CREATE TRIGGER discount_code_holds_transition
BEFORE UPDATE OF state ON discount_code_holds
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state
  AND NOT ((OLD.state = 'held' AND NEW.state IN ('released', 'used'))
           OR (OLD.state = 'released' AND NEW.state = 'used'))
BEGIN
  SELECT RAISE(ABORT, 'discount hold transition refused');
END;

CREATE TRIGGER discount_code_holds_frozen
BEFORE UPDATE ON discount_code_holds
FOR EACH ROW
WHEN NEW.hold_id IS NOT OLD.hold_id
  OR NEW.discount_code_id IS NOT OLD.discount_code_id
  OR NEW.checkout_id IS NOT OLD.checkout_id
  OR NEW.buyer_key IS NOT OLD.buyer_key
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.order_id IS NOT NULL AND NEW.order_id IS NOT OLD.order_id)
BEGIN
  SELECT RAISE(ABORT, 'discount hold facts are immutable');
END;

CREATE TRIGGER discount_code_holds_no_delete
BEFORE DELETE ON discount_code_holds
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'discount holds are kept');
END;

-- DC13 backstop: a code's name is frozen once it has been used or held. The
-- admin route answers 409 first. The webhook's burn never sets `code`, so
-- this trigger cannot touch the order batch.
CREATE TRIGGER discount_codes_code_frozen_once_used
BEFORE UPDATE OF code ON discount_codes
FOR EACH ROW
WHEN NEW.code IS NOT OLD.code
  AND (OLD.used_count > 0
       OR EXISTS (SELECT 1 FROM discount_code_holds
                  WHERE discount_code_id = OLD.discount_code_id))
BEGIN
  SELECT RAISE(ABORT, 'discount code in use');
END;

CREATE INDEX discount_code_holds_capacity_idx
  ON discount_code_holds(discount_code_id, state, expires_at);
CREATE INDEX discount_code_holds_buyer_idx
  ON discount_code_holds(tenant_id, discount_code_id, buyer_key);
