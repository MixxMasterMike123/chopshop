PRAGMA foreign_keys = ON;

-- ============================================================================
-- 0059 — CP13 (the affiliate program), part 2: the affiliate tables and the
-- affiliate facts frozen on checkouts and orders
-- (docs/cf-port/CP13_AFFILIATE_DESIGN.md §2.3, §3.1–§3.6b).
--
-- TIME. New tables use ISO-8601 UTC TEXT (PLAN §2.8) with the strftime
-- round-trip CHECK of 0013/0031/0033. New COLUMNS on checkouts and orders
-- follow those tables (INTEGER ms), but none of them is a time.
--
-- MONEY is integer minor units (öre) and basis points. Nothing stores a float.
--
-- TENANCY. Every table carries an immutable tenant_id; the affiliate's tenant
-- is the row's tenant everywhere a row names an affiliate (triggers below).
--
-- Who writes what: src/affiliate/* (applications, approval, codes, ledger,
-- payouts, clicks), src/commerce/checkout.ts (the frozen facts, at quote),
-- src/commerce/webhook.ts (the copy onto the order and the accrual, in the
-- order batch), src/commerce/refunds.ts and stripe-events.ts (reversals, in
-- the batch that moves the money).
-- ============================================================================


-- ── 1. affiliates (§3.1) ────────────────────────────────────────────────────
--
-- One row per (shop, person). The login is the "user" row (account_type
-- 'affiliate', 0058) plus a tenant_memberships row of role 'affiliate'; the
-- PROGRAM status lives here and gates the money paths: only `active`
-- resolves at checkout, counts a click or is offered; reversals, the ledger
-- and payouts ignore it.
--
-- NO DELETE, EVER (R2-9): the row is the tombstone every checkout and order
-- that froze its id points at. "Ta bort" sets `inactive` and revokes the
-- membership; the code stays taken.
--
-- terms_version / terms_accepted_at: the version the person accepted and
-- when. NULL, both, only for an affiliate the shop invited ("Bjud in
-- affiliate", no application): nobody accepted anything for them, and the
-- portal asks them to before anything else (design §8).
CREATE TABLE affiliates (
  affiliate_id TEXT PRIMARY KEY NOT NULL CHECK (length(affiliate_id) BETWEEN 1 AND 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Upper case, 3–20 of [A-Z0-9-]: what a buyer can type and a link can carry.
  code TEXT NOT NULL CHECK (
    length(code) BETWEEN 3 AND 20
    AND code = upper(code)
    AND code NOT GLOB '*[^A-Z0-9-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'suspended')),
  commission_bp INTEGER NOT NULL CHECK (commission_bp BETWEEN 0 AND 10000),
  discount_bp INTEGER NOT NULL CHECK (discount_bp BETWEEN 0 AND 10000),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  phone TEXT CHECK (phone IS NULL OR length(phone) BETWEEN 1 AND 40),
  address_line1 TEXT CHECK (address_line1 IS NULL OR length(address_line1) BETWEEN 1 AND 200),
  address_line2 TEXT CHECK (address_line2 IS NULL OR length(address_line2) BETWEEN 1 AND 200),
  postal_code TEXT CHECK (postal_code IS NULL OR length(postal_code) BETWEEN 1 AND 20),
  city TEXT CHECK (city IS NULL OR length(city) BETWEEN 1 AND 100),
  country TEXT NOT NULL DEFAULT 'SE' CHECK (length(country) = 2 AND country GLOB '[A-Z][A-Z]'),
  socials_json TEXT CHECK (
    socials_json IS NULL
    OR (json_valid(socials_json) AND json_type(socials_json) = 'object' AND length(socials_json) <= 4096)
  ),
  promotion_method TEXT CHECK (
    promotion_method IS NULL
    OR promotion_method IN ('blog', 'youtube', 'instagram', 'facebook', 'tiktok', 'forum', 'other')
  ),
  preferred_lang TEXT NOT NULL CHECK (preferred_lang IN ('sv', 'en')),
  terms_version TEXT CHECK (terms_version IS NULL OR length(terms_version) BETWEEN 1 AND 32),
  terms_accepted_at TEXT CHECK (
    terms_accepted_at IS NULL OR terms_accepted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', terms_accepted_at)
  ),
  application_id TEXT CHECK (application_id IS NULL OR length(application_id) BETWEEN 1 AND 64),
  -- The ledger currency this affiliate is paid in: the shop's at approval (R2-11).
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  -- The stamp of the batch that last admitted or re-activated this affiliate
  -- (approval, invite): the membership, the audit row and the mail of that
  -- batch are keyed on it, so an admission the guards refused writes
  -- nothing (the lifecycle pattern of 0033's status_change_id).
  change_id TEXT CHECK (change_id IS NULL OR length(change_id) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK (updated_at >= created_at),
  CHECK ((terms_version IS NULL) = (terms_accepted_at IS NULL)),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, user_id)
);

CREATE TRIGGER affiliates_tenant_immutable
BEFORE UPDATE OF tenant_id ON affiliates
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- Who the affiliate is, and in which currency it is paid, never changes.
CREATE TRIGGER affiliates_identity_immutable
BEFORE UPDATE ON affiliates
FOR EACH ROW
WHEN NEW.affiliate_id IS NOT OLD.affiliate_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.currency IS NOT OLD.currency
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'affiliate identity is immutable');
END;

CREATE TRIGGER affiliates_no_delete
BEFORE DELETE ON affiliates
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'affiliates are never deleted');
END;

-- One code namespace per shop across the two code families (D30, design
-- §3.1): refused at creation AND at rename, in both directions, inactive rows
-- included. The admin routes answer `conflict`. The message is matched by
-- src/affiliate/affiliates.ts and src/commerce/admin-discount-codes.ts.
CREATE TRIGGER affiliates_code_free_insert
BEFORE INSERT ON affiliates
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM discount_codes WHERE tenant_id = NEW.tenant_id AND code = NEW.code)
BEGIN
  SELECT RAISE(ABORT, 'affiliate code collides with a discount code');
END;

CREATE TRIGGER affiliates_code_free_update
BEFORE UPDATE OF code ON affiliates
FOR EACH ROW
WHEN NEW.code IS NOT OLD.code
  AND EXISTS (SELECT 1 FROM discount_codes WHERE tenant_id = NEW.tenant_id AND code = NEW.code)
BEGIN
  SELECT RAISE(ABORT, 'affiliate code collides with a discount code');
END;

CREATE TRIGGER discount_codes_code_free_insert
BEFORE INSERT ON discount_codes
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM affiliates WHERE tenant_id = NEW.tenant_id AND code = NEW.code)
BEGIN
  SELECT RAISE(ABORT, 'discount code collides with an affiliate code');
END;

CREATE TRIGGER discount_codes_code_free_update
BEFORE UPDATE OF code ON discount_codes
FOR EACH ROW
WHEN NEW.code IS NOT OLD.code
  AND EXISTS (SELECT 1 FROM affiliates WHERE tenant_id = NEW.tenant_id AND code = NEW.code)
BEGIN
  SELECT RAISE(ABORT, 'discount code collides with an affiliate code');
END;

-- The admin list, newest first.
CREATE INDEX affiliates_tenant_created_idx ON affiliates(tenant_id, created_at DESC, affiliate_id DESC);
CREATE INDEX affiliates_user_idx ON affiliates(user_id);


-- ── 2. affiliate_applications (§3.2) ────────────────────────────────────────
--
-- pending → approved | denied, a state machine (never a delete of a decided
-- row, except the retention below). `decision_id` is the stamp of the batch
-- that decided it: every other statement of that batch (the affiliate row,
-- the membership, the audit row, the mail) is keyed on it, so a decision the
-- guard refused writes nothing (the lifecycle pattern of 0033).
--
-- RETENTION (design §13.8, a D68 default): a DENIED row older than 12 months
-- is deleted by the daily cron (src/affiliate/applications.ts); approved rows
-- are the affiliate's own data and stay. Only a denied row can be deleted.
--
-- No address fields: they are collected in the portal before a first payout
-- (less personal data in an anonymous write, [DEV-9]).
CREATE TABLE affiliate_applications (
  application_id TEXT PRIMARY KEY NOT NULL CHECK (length(application_id) BETWEEN 1 AND 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- Lower case, as provision-users.ts parseEmail writes it.
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  phone TEXT CHECK (phone IS NULL OR length(phone) BETWEEN 1 AND 40),
  socials_json TEXT CHECK (
    socials_json IS NULL
    OR (json_valid(socials_json) AND json_type(socials_json) = 'object' AND length(socials_json) <= 4096)
  ),
  promotion_method TEXT NOT NULL CHECK (
    promotion_method IN ('blog', 'youtube', 'instagram', 'facebook', 'tiktok', 'forum', 'other')
  ),
  message TEXT CHECK (message IS NULL OR length(message) BETWEEN 1 AND 2000),
  preferred_lang TEXT NOT NULL CHECK (preferred_lang IN ('sv', 'en')),
  terms_version TEXT NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 32),
  terms_accepted_at TEXT NOT NULL CHECK (terms_accepted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', terms_accepted_at)),
  decision_id TEXT CHECK (decision_id IS NULL OR length(decision_id) BETWEEN 1 AND 64),
  decided_by TEXT CHECK (decided_by IS NULL OR length(decided_by) BETWEEN 1 AND 128),
  decided_at TEXT CHECK (decided_at IS NULL OR decided_at IS strftime('%Y-%m-%dT%H:%M:%fZ', decided_at)),
  decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 500),
  affiliate_id TEXT CHECK (affiliate_id IS NULL OR length(affiliate_id) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK (updated_at >= created_at),
  -- A decided row says who, when and by which batch; a pending one says none.
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  CHECK ((decided_at IS NULL) = (decision_id IS NULL)),
  CHECK ((status = 'approved') = (affiliate_id IS NOT NULL)),
  -- A denial's reason is mailed to the applicant.
  CHECK ((status = 'denied') = (decision_reason IS NOT NULL))
);

CREATE TRIGGER affiliate_applications_tenant_immutable
BEFORE UPDATE OF tenant_id ON affiliate_applications
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER affiliate_applications_born_pending
BEFORE INSERT ON affiliate_applications
FOR EACH ROW
WHEN NEW.status IS NOT 'pending'
BEGIN
  SELECT RAISE(ABORT, 'an affiliate application is born pending');
END;

-- pending → approved | denied, once; what the applicant sent never changes.
CREATE TRIGGER affiliate_applications_transition
BEFORE UPDATE ON affiliate_applications
FOR EACH ROW
WHEN NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'denied'))
  OR NEW.application_id IS NOT OLD.application_id
  OR NEW.name IS NOT OLD.name
  OR NEW.email IS NOT OLD.email
  OR NEW.phone IS NOT OLD.phone
  OR NEW.socials_json IS NOT OLD.socials_json
  OR NEW.promotion_method IS NOT OLD.promotion_method
  OR NEW.message IS NOT OLD.message
  OR NEW.preferred_lang IS NOT OLD.preferred_lang
  OR NEW.terms_version IS NOT OLD.terms_version
  OR NEW.terms_accepted_at IS NOT OLD.terms_accepted_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'an affiliate application only moves from pending to approved or denied');
END;

CREATE TRIGGER affiliate_applications_delete_denied_only
BEFORE DELETE ON affiliate_applications
FOR EACH ROW
WHEN OLD.status IS NOT 'denied'
BEGIN
  SELECT RAISE(ABORT, 'only a denied affiliate application is deleted');
END;

-- One pending application per address and shop: a second submission answers
-- the same 202 and stores nothing (no oracle on whether an address applied).
CREATE UNIQUE INDEX affiliate_applications_one_pending_idx
  ON affiliate_applications(tenant_id, email) WHERE status = 'pending';
CREATE INDEX affiliate_applications_tenant_status_idx
  ON affiliate_applications(tenant_id, status, created_at DESC, application_id DESC);
CREATE INDEX affiliate_applications_retention_idx
  ON affiliate_applications(status, decided_at);


-- ── 3. affiliate_terms_versions (§3.3, §8) ──────────────────────────────────
--
-- The 0031 shape. The text is the template in src/affiliate/terms.ts; the
-- hash is SHA-256 over the UTF-8 of JSON.stringify({ template, version })
-- (affiliateTermsSha256, pinned by test/affiliate-schema.test.ts).
CREATE TABLE affiliate_terms_versions (
  version TEXT PRIMARY KEY NOT NULL CHECK (
    length(version) BETWEEN 1 AND 32 AND version NOT GLOB '*[^0-9A-Za-z._-]*'
  ),
  published_at TEXT NOT NULL CHECK (published_at IS strftime('%Y-%m-%dT%H:%M:%fZ', published_at)),
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64 AND text_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);

CREATE TRIGGER affiliate_terms_versions_no_update
BEFORE UPDATE ON affiliate_terms_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'affiliate terms versions are append-only');
END;

CREATE TRIGGER affiliate_terms_versions_no_delete
BEFORE DELETE ON affiliate_terms_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'affiliate terms versions are append-only');
END;

INSERT INTO affiliate_terms_versions (version, published_at, text_sha256, created_at)
VALUES (
  '2026-10-22',
  '2026-10-22T00:00:00.000Z',
  'ee41588cc6c220b79f1599c3febf04efde767f2a6a7b367f48f6b54be1779a3c',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);


-- ── 4. affiliate_click_days (§3.4, D27) ─────────────────────────────────────
--
-- Referral-link landings per affiliate and UTC day. No other column: no IP,
-- no user agent, no referrer, no visitor id. Nothing to purge.
CREATE TABLE affiliate_click_days (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  affiliate_id TEXT NOT NULL CHECK (length(affiliate_id) BETWEEN 1 AND 64),
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(day) IS day),
  count INTEGER NOT NULL CHECK (count >= 1),
  PRIMARY KEY (tenant_id, affiliate_id, day)
);

CREATE TRIGGER affiliate_click_days_tenant_immutable
BEFORE UPDATE OF tenant_id, affiliate_id, day ON affiliate_click_days
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
  OR OLD.affiliate_id IS NOT NEW.affiliate_id
  OR OLD.day IS NOT NEW.day
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER affiliate_click_days_tenant_matches_affiliate
BEFORE INSERT ON affiliate_click_days
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM affiliates WHERE affiliate_id = NEW.affiliate_id AND tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'click day tenant must match its affiliate');
END;


-- ── 5. affiliate_ledger (§3.5, §4) ──────────────────────────────────────────
--
-- APPEND-ONLY. Balances are sums (§4.4); nothing is stored that could
-- disagree with them.
--
--   accrual      > 0   the commission of one paid order (ref = order_id),
--                      written in the webhook's order batch; formula_version
--                      and available_at (paid_at + 14 days) are set
--   reversal     ≠ 0   money that went back: NEGATIVE on a refund or a lost
--                      dispute, POSITIVE when a succeeded refund later fails
--                      (R2-1); ref = the refund operation's TRANSITION id, or
--                      the dispute id (R2-4)
--   payout       < 0   a payout request reserved this much (ref = payout_id)
--   payout_void  > 0   a voided request gave it back (ref = payout_id)
--   adjustment   ≠ 0   an admin's correction, with a reason (ref = a fresh id)
--
-- UNIQUE (tenant, affiliate, kind, ref) makes every writer idempotent: the
-- writers use INSERT … SELECT … WHERE NOT EXISTS, so a replay inserts nothing
-- and never aborts the batch that moves money.
CREATE TABLE affiliate_ledger (
  entry_id TEXT PRIMARY KEY NOT NULL CHECK (length(entry_id) BETWEEN 1 AND 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  affiliate_id TEXT NOT NULL CHECK (length(affiliate_id) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (kind IN ('accrual', 'reversal', 'payout', 'payout_void', 'adjustment')),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  order_id TEXT,
  ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 128),
  formula_version INTEGER CHECK (formula_version IS NULL OR formula_version >= 1),
  available_at TEXT CHECK (available_at IS NULL OR available_at IS strftime('%Y-%m-%dT%H:%M:%fZ', available_at)),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  CHECK (
    (kind = 'accrual' AND amount_minor > 0 AND order_id IS NOT NULL AND ref = order_id
      AND formula_version IS NOT NULL AND available_at IS NOT NULL AND reason IS NULL)
    OR (kind = 'reversal' AND amount_minor <> 0 AND order_id IS NOT NULL
      AND formula_version IS NULL AND available_at IS NULL AND reason IS NULL)
    OR (kind = 'payout' AND amount_minor < 0 AND order_id IS NULL
      AND formula_version IS NULL AND available_at IS NULL)
    OR (kind = 'payout_void' AND amount_minor > 0 AND order_id IS NULL
      AND formula_version IS NULL AND available_at IS NULL)
    OR (kind = 'adjustment' AND amount_minor <> 0 AND reason IS NOT NULL
      AND formula_version IS NULL AND available_at IS NULL)
  ),
  UNIQUE (tenant_id, affiliate_id, kind, ref)
);

CREATE TRIGGER affiliate_ledger_no_update
BEFORE UPDATE ON affiliate_ledger
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'the affiliate ledger is append-only');
END;

CREATE TRIGGER affiliate_ledger_no_delete
BEFORE DELETE ON affiliate_ledger
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'the affiliate ledger is append-only');
END;

-- The REPLACE guard (0033's note, R2-22): INSERT OR REPLACE deletes the row it
-- displaces WITHOUT firing the delete trigger. An insert whose entry id is
-- already taken is refused outright.
CREATE TRIGGER affiliate_ledger_no_displacement
BEFORE INSERT ON affiliate_ledger
FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM affiliate_ledger WHERE entry_id = NEW.entry_id)
  OR EXISTS (
    SELECT 1 FROM affiliate_ledger
    WHERE tenant_id = NEW.tenant_id AND affiliate_id = NEW.affiliate_id
      AND kind = NEW.kind AND ref = NEW.ref
  )
BEGIN
  SELECT RAISE(ABORT, 'the affiliate ledger is append-only');
END;

-- The affiliate, and the order a row names, belong to the row's tenant.
CREATE TRIGGER affiliate_ledger_tenant_matches
BEFORE INSERT ON affiliate_ledger
FOR EACH ROW
WHEN NOT EXISTS (
    SELECT 1 FROM affiliates WHERE affiliate_id = NEW.affiliate_id AND tenant_id = NEW.tenant_id
  )
  OR (NEW.order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM orders WHERE order_id = NEW.order_id AND tenant_id = NEW.tenant_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'ledger tenant must match its affiliate and order');
END;

CREATE INDEX affiliate_ledger_affiliate_idx
  ON affiliate_ledger(tenant_id, affiliate_id, created_at DESC, entry_id DESC);
CREATE INDEX affiliate_ledger_order_idx ON affiliate_ledger(tenant_id, order_id, kind);


-- ── 6. affiliate_payouts (§3.6, §6) ─────────────────────────────────────────
--
--   requested ──► paid   the shop's recorded EVIDENCE of a payment made
--       │                outside the system (reference, date, who)
--       └──────► void    released by a compensating `payout_void` ledger row
--
-- `paid` and `void` are final. The ledger's `payout` row (−amount) is written
-- in the SAME batch as the `requested` row, guarded on it; one open request
-- per affiliate (the partial UNIQUE below), so a racing second request — or an
-- admin's record while a request is open — fails with `conflict`.
-- rail: 'manual' at launch (the invoice rail); 'connect' is designed (§6.3)
-- and not built.
CREATE TABLE affiliate_payouts (
  payout_id TEXT PRIMARY KEY NOT NULL CHECK (length(payout_id) BETWEEN 1 AND 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  affiliate_id TEXT NOT NULL CHECK (length(affiliate_id) BETWEEN 1 AND 64),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  status TEXT NOT NULL CHECK (status IN ('requested', 'paid', 'void')),
  rail TEXT NOT NULL CHECK (rail IN ('manual', 'connect')),
  invoice_object_id TEXT CHECK (invoice_object_id IS NULL OR length(invoice_object_id) BETWEEN 1 AND 64),
  invoice_number TEXT CHECK (invoice_number IS NULL OR length(invoice_number) BETWEEN 1 AND 50),
  requested_by TEXT NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 128),
  requested_at TEXT NOT NULL CHECK (requested_at IS strftime('%Y-%m-%dT%H:%M:%fZ', requested_at)),
  paid_at TEXT CHECK (paid_at IS NULL OR paid_at IS strftime('%Y-%m-%dT%H:%M:%fZ', paid_at)),
  paid_by TEXT CHECK (paid_by IS NULL OR length(paid_by) BETWEEN 1 AND 128),
  paid_reference TEXT CHECK (paid_reference IS NULL OR length(paid_reference) BETWEEN 1 AND 100),
  notes TEXT CHECK (notes IS NULL OR length(notes) BETWEEN 1 AND 1000),
  voided_at TEXT CHECK (voided_at IS NULL OR voided_at IS strftime('%Y-%m-%dT%H:%M:%fZ', voided_at)),
  voided_by TEXT CHECK (voided_by IS NULL OR length(voided_by) BETWEEN 1 AND 128),
  void_reason TEXT CHECK (void_reason IS NULL OR length(void_reason) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK ((paid_at IS NULL) = (paid_by IS NULL)),
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);

CREATE TRIGGER affiliate_payouts_tenant_immutable
BEFORE UPDATE OF tenant_id ON affiliate_payouts
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER affiliate_payouts_born_requested
BEFORE INSERT ON affiliate_payouts
FOR EACH ROW
WHEN NEW.status IS NOT 'requested'
  OR NOT EXISTS (
    SELECT 1 FROM affiliates WHERE affiliate_id = NEW.affiliate_id AND tenant_id = NEW.tenant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'a payout is born requested, for an affiliate of its tenant');
END;

-- requested → paid | void; final after that. What was requested never changes.
CREATE TRIGGER affiliate_payouts_transition
BEFORE UPDATE ON affiliate_payouts
FOR EACH ROW
WHEN NOT (OLD.status = 'requested' AND NEW.status IN ('paid', 'void'))
  OR NEW.payout_id IS NOT OLD.payout_id
  OR NEW.affiliate_id IS NOT OLD.affiliate_id
  OR NEW.amount_minor IS NOT OLD.amount_minor
  OR NEW.currency IS NOT OLD.currency
  OR NEW.rail IS NOT OLD.rail
  OR NEW.invoice_object_id IS NOT OLD.invoice_object_id
  OR NEW.invoice_number IS NOT OLD.invoice_number
  OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.requested_at IS NOT OLD.requested_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'a payout only moves from requested to paid or void');
END;

CREATE TRIGGER affiliate_payouts_no_delete
BEFORE DELETE ON affiliate_payouts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'payouts are never deleted');
END;

-- (§5's ledger, declared here because it reads affiliate_payouts.) A payout
-- row and its void are the payout's own amount, written beside it.
CREATE TRIGGER affiliate_ledger_payout_matches
BEFORE INSERT ON affiliate_ledger
FOR EACH ROW
WHEN (NEW.kind = 'payout' AND NOT EXISTS (
    SELECT 1 FROM affiliate_payouts AS p
    WHERE p.payout_id = NEW.ref AND p.tenant_id = NEW.tenant_id
      AND p.affiliate_id = NEW.affiliate_id AND p.currency = NEW.currency
      AND p.amount_minor = -NEW.amount_minor
  ))
  OR (NEW.kind = 'payout_void' AND NOT EXISTS (
    SELECT 1 FROM affiliate_payouts AS p
    WHERE p.payout_id = NEW.ref AND p.tenant_id = NEW.tenant_id
      AND p.affiliate_id = NEW.affiliate_id AND p.currency = NEW.currency
      AND p.amount_minor = NEW.amount_minor AND p.status = 'void'
  ))
BEGIN
  SELECT RAISE(ABORT, 'a payout ledger row must match its payout');
END;

CREATE UNIQUE INDEX affiliate_payouts_one_open_idx
  ON affiliate_payouts(tenant_id, affiliate_id) WHERE status = 'requested';
CREATE INDEX affiliate_payouts_affiliate_idx
  ON affiliate_payouts(tenant_id, affiliate_id, created_at DESC, payout_id DESC);


-- ── 6b. affiliate_invoice_objects (§3.6b, R2-12) ────────────────────────────
--
-- Which private `document` object an affiliate reserved as an invoice,
-- written in the reserve batch. A payout request accepts only an object
-- listed here for the requesting affiliate (and active, of its tenant), and
-- marks it immutable in the request batch, so the shop's object DELETE
-- (mutable objects only) cannot remove financial evidence.
CREATE TABLE affiliate_invoice_objects (
  object_id TEXT PRIMARY KEY NOT NULL REFERENCES stored_objects(object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  affiliate_id TEXT NOT NULL CHECK (length(affiliate_id) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);

CREATE TRIGGER affiliate_invoice_objects_no_update
BEFORE UPDATE ON affiliate_invoice_objects
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'affiliate invoice objects are append-only');
END;

CREATE TRIGGER affiliate_invoice_objects_no_delete
BEFORE DELETE ON affiliate_invoice_objects
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'affiliate invoice objects are append-only');
END;

CREATE TRIGGER affiliate_invoice_objects_tenant_matches
BEFORE INSERT ON affiliate_invoice_objects
FOR EACH ROW
WHEN NOT EXISTS (
    SELECT 1 FROM stored_objects
    WHERE object_id = NEW.object_id AND tenant_id = NEW.tenant_id AND kind = 'document'
  )
  OR NOT EXISTS (
    SELECT 1 FROM affiliates WHERE affiliate_id = NEW.affiliate_id AND tenant_id = NEW.tenant_id
  )
BEGIN
  SELECT RAISE(ABORT, 'an affiliate invoice is a document of the affiliate''s tenant');
END;

CREATE INDEX affiliate_invoice_objects_affiliate_idx
  ON affiliate_invoice_objects(tenant_id, affiliate_id);


-- ── 7. checkouts and orders: the affiliate facts (§2.3) ─────────────────────
--
-- The seam's representation (design §2.2, CX-B1): an affiliate hit freezes
-- the AFFILIATE's id in the existing `discount_code_id` (0010's "the id of
-- whatever authorized it"), so 0010/0011's "discounted money was authorized
-- by something" CHECK holds without rebuilding either table, and
-- `discount_authority` says which family the id belongs to. Every reader of
-- the id is authority-aware: the hold (checkout.ts) and the burn (webhook.ts)
-- run only when the authority IS NOT 'affiliate'.
--
--   discount_authority       'campaign' | 'affiliate' | NULL; never set
--                            without an id; NULL beside an id = a legacy
--                            campaign id (the deploy window, trigger below)
--   affiliate_id             the affiliates row; = discount_code_id; NOT NULL
--                            iff the authority is 'affiliate'
--   affiliate_code           the code as resolved, for display without a join
--   affiliate_attribution    'link' | 'code'
--   affiliate_commission_bp  the rates frozen at quote time: the accrual is a
--   affiliate_discount_bp    pure function of frozen facts (§4.1)
--   affiliate_self_referral  0 | 1, decided at QUOTE time from the buyer's
--                            address (§4.3, CX-B2)
--
-- No foreign key, for 0010's reason: a re-coded or retired affiliate must not
-- change a historical row.
--
-- THE ORDER OF THE STATEMENTS MATTERS (R2-2). SQLite (≥ 3.37) tests an ADD
-- COLUMN's CHECK against the rows already in the table, so
-- `discount_authority` is added WITHOUT the "no authority without an id" rule, then
-- backfilled 'campaign' wherever a campaign id is frozen, and only then is
-- the rule declared — as BEFORE INSERT / UPDATE triggers, which SQLite never
-- applies to rows that already exist. A checkout quoted before this migration
-- and paid after it therefore carries 'campaign' and burns as before. The six
-- affiliate columns' own CHECKs tie them to the authority; every existing row
-- has them NULL and its authority NULL or 'campaign', so they hold for it.

ALTER TABLE checkouts ADD COLUMN discount_authority TEXT CHECK (
  discount_authority IS NULL OR discount_authority IN ('campaign', 'affiliate')
);
ALTER TABLE orders ADD COLUMN discount_authority TEXT CHECK (
  discount_authority IS NULL OR discount_authority IN ('campaign', 'affiliate')
);

UPDATE checkouts SET discount_authority = 'campaign' WHERE discount_code_id IS NOT NULL;
UPDATE orders SET discount_authority = 'campaign' WHERE discount_code_id IS NOT NULL;

ALTER TABLE checkouts ADD COLUMN affiliate_id TEXT CHECK (
  (affiliate_id IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_id IS NULL OR length(affiliate_id) BETWEEN 1 AND 64)
);
ALTER TABLE checkouts ADD COLUMN affiliate_code TEXT CHECK (
  (affiliate_code IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_code IS NULL OR (
    length(affiliate_code) BETWEEN 3 AND 20
    AND affiliate_code = upper(affiliate_code)
    AND affiliate_code NOT GLOB '*[^A-Z0-9-]*'
  ))
);
ALTER TABLE checkouts ADD COLUMN affiliate_attribution TEXT CHECK (
  (affiliate_attribution IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_attribution IS NULL OR affiliate_attribution IN ('link', 'code'))
);
ALTER TABLE checkouts ADD COLUMN affiliate_commission_bp INTEGER CHECK (
  (affiliate_commission_bp IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_commission_bp IS NULL OR affiliate_commission_bp BETWEEN 0 AND 10000)
);
ALTER TABLE checkouts ADD COLUMN affiliate_discount_bp INTEGER CHECK (
  (affiliate_discount_bp IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_discount_bp IS NULL OR affiliate_discount_bp BETWEEN 0 AND 10000)
);
ALTER TABLE checkouts ADD COLUMN affiliate_self_referral INTEGER CHECK (
  (affiliate_self_referral IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_self_referral IS NULL OR affiliate_self_referral IN (0, 1))
);

ALTER TABLE orders ADD COLUMN affiliate_id TEXT CHECK (
  (affiliate_id IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_id IS NULL OR length(affiliate_id) BETWEEN 1 AND 64)
);
ALTER TABLE orders ADD COLUMN affiliate_code TEXT CHECK (
  (affiliate_code IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_code IS NULL OR (
    length(affiliate_code) BETWEEN 3 AND 20
    AND affiliate_code = upper(affiliate_code)
    AND affiliate_code NOT GLOB '*[^A-Z0-9-]*'
  ))
);
ALTER TABLE orders ADD COLUMN affiliate_attribution TEXT CHECK (
  (affiliate_attribution IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_attribution IS NULL OR affiliate_attribution IN ('link', 'code'))
);
ALTER TABLE orders ADD COLUMN affiliate_commission_bp INTEGER CHECK (
  (affiliate_commission_bp IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_commission_bp IS NULL OR affiliate_commission_bp BETWEEN 0 AND 10000)
);
ALTER TABLE orders ADD COLUMN affiliate_discount_bp INTEGER CHECK (
  (affiliate_discount_bp IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_discount_bp IS NULL OR affiliate_discount_bp BETWEEN 0 AND 10000)
);
ALTER TABLE orders ADD COLUMN affiliate_self_referral INTEGER CHECK (
  (affiliate_self_referral IS NOT NULL) = (discount_authority IS 'affiliate')
  AND (affiliate_self_referral IS NULL OR affiliate_self_referral IN (0, 1))
);

-- Coherence, from here on (see above for why a trigger and not a CHECK): an
-- authority is never set without a frozen id, and an affiliate authority
-- freezes the affiliate's own id.
--
-- THE DEPLOY WINDOW (A1 review round 1, MUST-1). Between `migrations apply`
-- and the Worker deploy, the OLD Worker still runs: its checkout INSERT and
-- its webhook's order INSERT name `discount_code_id` but not
-- `discount_authority`. Such a row — an id with a NULL authority — is a
-- LEGACY CAMPAIGN id and is ADMITTED here (a refusal would 500 every
-- discounted checkout and roll back the order batch of every discounted
-- payment in that window). Every reader already treats a NULL authority
-- beside an id as a campaign's: the burn and the hold run on `IS NOT
-- 'affiliate'`, the labels COALESCE on `IS NOT 'affiliate'`, the checkout
-- replay reads NULL-with-id as 'campaign'. What stays refused: an authority
-- with no id, and an affiliate authority whose id is not the affiliate's.
CREATE TRIGGER checkouts_discount_authority_coherent_insert
BEFORE INSERT ON checkouts
FOR EACH ROW
WHEN (NEW.discount_authority IS NOT NULL AND NEW.discount_code_id IS NULL)
  OR (NEW.discount_authority IS 'affiliate' AND NEW.discount_code_id IS NOT NEW.affiliate_id)
BEGIN
  SELECT RAISE(ABORT, 'discount authority is incoherent');
END;

CREATE TRIGGER checkouts_discount_authority_coherent_update
BEFORE UPDATE OF discount_code_id, discount_authority, affiliate_id ON checkouts
FOR EACH ROW
WHEN (NEW.discount_authority IS NOT NULL AND NEW.discount_code_id IS NULL)
  OR (NEW.discount_authority IS 'affiliate' AND NEW.discount_code_id IS NOT NEW.affiliate_id)
BEGIN
  SELECT RAISE(ABORT, 'discount authority is incoherent');
END;

CREATE TRIGGER orders_discount_authority_coherent_insert
BEFORE INSERT ON orders
FOR EACH ROW
WHEN (NEW.discount_authority IS NOT NULL AND NEW.discount_code_id IS NULL)
  OR (NEW.discount_authority IS 'affiliate' AND NEW.discount_code_id IS NOT NEW.affiliate_id)
BEGIN
  SELECT RAISE(ABORT, 'discount authority is incoherent');
END;

CREATE TRIGGER orders_discount_authority_coherent_update
BEFORE UPDATE OF discount_code_id, discount_authority, affiliate_id ON orders
FOR EACH ROW
WHEN (NEW.discount_authority IS NOT NULL AND NEW.discount_code_id IS NULL)
  OR (NEW.discount_authority IS 'affiliate' AND NEW.discount_code_id IS NOT NEW.affiliate_id)
BEGIN
  SELECT RAISE(ABORT, 'discount authority is incoherent');
END;

-- FROZEN from the moment they are written (R2-Q1, the 0019
-- checkouts_connect_facts_frozen shape without its "first non-null"
-- exception: a checkout is quoted once). 0011's orders_money_immutable
-- covers discount_code_id on the order, not these seven.
CREATE TRIGGER checkouts_affiliate_facts_frozen
BEFORE UPDATE ON checkouts
FOR EACH ROW
WHEN NEW.discount_authority IS NOT OLD.discount_authority
  OR NEW.affiliate_id IS NOT OLD.affiliate_id
  OR NEW.affiliate_code IS NOT OLD.affiliate_code
  OR NEW.affiliate_attribution IS NOT OLD.affiliate_attribution
  OR NEW.affiliate_commission_bp IS NOT OLD.affiliate_commission_bp
  OR NEW.affiliate_discount_bp IS NOT OLD.affiliate_discount_bp
  OR NEW.affiliate_self_referral IS NOT OLD.affiliate_self_referral
BEGIN
  SELECT RAISE(ABORT, 'checkout affiliate facts are frozen');
END;

CREATE TRIGGER orders_affiliate_facts_frozen
BEFORE UPDATE ON orders
FOR EACH ROW
WHEN NEW.discount_authority IS NOT OLD.discount_authority
  OR NEW.affiliate_id IS NOT OLD.affiliate_id
  OR NEW.affiliate_code IS NOT OLD.affiliate_code
  OR NEW.affiliate_attribution IS NOT OLD.affiliate_attribution
  OR NEW.affiliate_commission_bp IS NOT OLD.affiliate_commission_bp
  OR NEW.affiliate_discount_bp IS NOT OLD.affiliate_discount_bp
  OR NEW.affiliate_self_referral IS NOT OLD.affiliate_self_referral
BEGIN
  SELECT RAISE(ABORT, 'order affiliate facts are immutable');
END;

-- The admin's "orders of this affiliate" read.
CREATE INDEX orders_tenant_affiliate_idx
  ON orders(tenant_id, affiliate_id, created_at DESC) WHERE affiliate_id IS NOT NULL;
