PRAGMA foreign_keys = ON;

-- Campaign discount codes ("Rabattkoder"), mirroring production's
-- `discountCodes` collection (src/pages/admin/AdminDiscountCodes.jsx for the
-- write shape, functions/src/payment/createPaymentIntent.ts for the authority
-- read, functions/src/affiliate/callable/validateDiscountCode.ts for the
-- eligibility predicates).
--
-- SCOPE OF THIS MIGRATION: campaign codes only. Production checks AFFILIATE
-- codes first and lets them win a collision; the affiliate domain has not been
-- migrated, so no affiliate table exists here yet. The resolution seam is
-- documented in src/commerce/discount-codes.ts — the affiliate branch slots in
-- AHEAD of the campaign lookup, not beside it.

CREATE TABLE discount_codes (
  discount_code_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Stored UPPERCASE, which is also how the checkout looks it up: production
  -- normalizes with `code.trim().toUpperCase()` on both the write
  -- (normalizeAffiliateCode) and every read, so a lowercase entry still
  -- validates at checkout. The shape is validated app-side against the same
  -- 50-character bound the production callable enforces; what SQLite can state
  -- is that the stored value is non-empty, bounded, and already uppercase, so a
  -- row written by any future path is still findable by the lookup.
  code TEXT NOT NULL CHECK (
    length(code) >= 1
    AND length(code) <= 50
    AND code = upper(code)
  ),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  type TEXT NOT NULL CHECK (type IN ('fixed', 'percent')),
  -- The value carried by a 'fixed' code, in minor units. The ceiling matches the
  -- product price ceiling: a fixed discount larger than the most expensive
  -- single item is already absurd, and the clamp to the discountable base means
  -- a bigger number could not spend itself anyway.
  value_minor INTEGER CHECK (value_minor IS NULL OR (value_minor >= 0 AND value_minor <= 100000000)),
  -- The value carried by a 'percent' code, in BASIS POINTS rather than whole
  -- percent. Production stores a JS number and computes
  -- `Math.ceil(base * value / 100)`, which admits a fractional percent such as
  -- 12.5. Storing 1250 bp keeps that exactly representable while keeping the
  -- money path integer-only: the engine computes ceil(base * bp / 10000). 10000
  -- bp is 100%, the ceiling the production admin form enforces.
  percent_bp INTEGER CHECK (percent_bp IS NULL OR (percent_bp >= 1 AND percent_bp <= 10000)),
  -- Validity window, ms epoch, both bounds optional and both INCLUSIVE —
  -- production tests `now >= startsAt && now <= endsAt`, so a code whose window
  -- ends at exactly `now` is still eligible on that millisecond. The ordering
  -- constraint is a table-level CHECK below, with the other cross-column rules.
  starts_at INTEGER,
  ends_at INTEGER,
  -- Usage cap. NULL means unlimited, matching production's `maxUses` being
  -- absent. The admin form floors an entered cap at 1, so 0 is not a value a
  -- merchant can mean: a code nobody may use is a deactivated code.
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses >= 1),
  -- Incremented by the PAYMENT checkpoint, never here and never by an admin.
  -- See the checkouts.discount_code_id note below.
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  -- Minimum basket value, minor units. Compared against the FULL subtotal, not
  -- the scoped base — production compares `subtotal >= minSpend` even for a
  -- products-scoped code, and the client does the same, so the two sides agree.
  min_spend_minor INTEGER CHECK (min_spend_minor IS NULL OR min_spend_minor >= 0),
  scope TEXT NOT NULL CHECK (scope IN ('all', 'products')),
  -- The product-ID list for a products-scoped code, as a JSON array of strings.
  --
  -- Deliberately NOT a join table with a foreign key. Production stores a loose
  -- array of document ids and tolerates ids that no longer resolve: a deleted
  -- product simply contributes nothing to the discountable base. An FK-enforced
  -- child table would instead make deleting a product fail, or cascade the list
  -- out from under the merchant, and either behaviour is a divergence from what
  -- the merchant sees in production today. The array is validated app-side
  -- (string entries, bounded count and length) before it is written; SQLite
  -- states only that it is a JSON array when present.
  --
  -- The scope pairing is a table-level CHECK below.
  product_ids_json TEXT CHECK (
    product_ids_json IS NULL
    OR (json_valid(product_ids_json) AND json_type(product_ids_json) = 'array')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),

  -- SQLite requires every table-level constraint to follow every column
  -- definition, so the three cross-column rules live here rather than beside
  -- the columns they govern.

  -- The value XOR, expressed against `type` so neither column can be populated
  -- for the wrong kind of code and neither can be missing for the right one.
  -- Without this a 'percent' row could carry only value_minor and the engine
  -- would silently discount nothing, which reads as an ineligible code rather
  -- than as the corrupt row it is.
  CHECK (
    (type = 'fixed' AND value_minor IS NOT NULL AND percent_bp IS NULL)
    OR (type = 'percent' AND percent_bp IS NOT NULL AND value_minor IS NULL)
  ),

  -- Window ordering. A window that ends before it starts is never open, so a
  -- merchant who wrote one has made a mistake the engine would report as a
  -- permanently ineligible code.
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at),

  -- The scope pairing, an equivalence in both directions and verified
  -- enforceable on this D1 instance: a products-scoped code MUST carry a list,
  -- and an all-scoped code must NOT. Allowing an ignored list on an 'all' code
  -- would leave a merchant believing they had scoped a discount that in fact
  -- applies to everything.
  CHECK ((scope = 'products') = (product_ids_json IS NOT NULL)),

  -- A code is unique within its tenant and meaningless outside it. Two
  -- storefronts may legitimately both run "SUMMER20"; neither may resolve the
  -- other's.
  UNIQUE (tenant_id, code)
);

CREATE TRIGGER discount_codes_tenant_immutable
BEFORE UPDATE OF tenant_id ON discount_codes
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- The checkout lookup: (tenant, code) exact match. The UNIQUE constraint above
-- already provides this index, so the only additional one worth carrying is the
-- admin listing order, which reads a tenant's codes newest-first.
CREATE INDEX discount_codes_tenant_created_idx
  ON discount_codes(tenant_id, created_at DESC);

-- The resolved code, frozen on the checkout row.
--
-- NO FOREIGN KEY, deliberately. A merchant may delete a campaign code next
-- month; the checkout's frozen numbers must survive that unchanged, because
-- they are what a buyer was quoted and what the payment checkpoint will charge.
-- An FK would either block the delete or drag the id out of a historical row,
-- and both make the money record answer to the catalogue rather than the other
-- way round. The id is a breadcrumb for the payment checkpoint's atomic
-- used_count increment and for reconciliation, not an authority.
--
-- BOTH invariants below were probed on this D1 instance rather than assumed:
-- ALTER TABLE ... ADD COLUMN accepts a CHECK referencing pre-existing columns,
-- and the constraint is genuinely enforced on INSERT and on UPDATE (a row with
-- discount_minor > 0 and a NULL code id is rejected either way). They ride on
-- this one column's CHECK because SQLite cannot ALTER a table's CHECK list and
-- a `checkouts` recreate is expensive — 0009 had to rebuild both tables and
-- re-declare nine triggers and three indexes to replace a single constraint.
-- Attaching them here costs nothing: the column is nullable with no default, so
-- no historical row is rewritten, and every historical row satisfies both
-- (they all have discount_minor = 0).
--
--   1. Discounted money was authorized by something.
--   2. The discount applies to the SUBTOTAL and never to carriage. 0009's
--      contract (`total = subtotal + shipping - discount`) plus
--      `total_minor >= 0` only bounds the discount at subtotal + shipping,
--      which would let a code eat the shipping cost. This is the tighter bound,
--      and it is the one the scope rule needs: a products-scoped base is a
--      SUBSET of the subtotal, so a discount exceeding the subtotal could only
--      come from a computation error, never from a legitimate quote.
ALTER TABLE checkouts ADD COLUMN discount_code_id TEXT CHECK (
  ((discount_minor = 0) OR (discount_code_id IS NOT NULL))
  AND discount_minor <= subtotal_minor
);
