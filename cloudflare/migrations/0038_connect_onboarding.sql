PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP3-F — Stripe Connect onboarding (Firebase
-- functions/src/payment/connectOnboarding.ts): the platform's per-shop opt-in,
-- the seller-facing Connect facts, and the reserve-first operation that
-- creates a shop's ONE connected account.
--
-- Additive only. The account itself and its capability flags are 0019's
-- (`stripe_account_id` with its partial UNIQUE index, `stripe_charges_enabled`
-- / `stripe_payouts_enabled` / `stripe_details_submitted`, the flags-need-an-
-- account triggers) and 0027's (`stripe_account_resync_needed`); ordering is
-- still `stripe_account_synced_at` (the applied `account.updated` event's
-- `created`, in ms). Nothing here re-declares or re-purposes them.
--
-- TIME. The new TABLE uses ISO-8601 UTC TEXT with the 0013/0017/0028
-- round-trip CHECK. The new `tenants` columns hold no timestamps.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- tenants — the Connect opt-in and the facts the seller is shown.
--
--   connect_enabled
--     The PLATFORM's opt-in (Firebase `payments.connectEnabled`). While 0, the
--     seller cannot create an account or get an onboarding link. It is an
--     invitation, not a payment gate: the payment route keys on
--     `stripe_account_id` + `stripe_charges_enabled` only (src/commerce/
--     payment.ts), exactly as Firebase's money path keyed on chargesEnabled.
--
--   stripe_requirements_due_json
--     What Stripe still needs from the seller: v1 `requirements.currently_due`
--     (field codes such as "external_account"). A JSON array of strings,
--     capped by the writer (50 entries x 120 chars) and here (8 KiB). NULL =
--     never read.
--
--   stripe_disabled_reason
--     v1 `requirements.disabled_reason` (e.g. "requirements.past_due"), or
--     NULL. Drives the derived status 'restricted'. A code, never prose.
--
--   payout_delay_days
--     The platform's per-account payout hold (Firebase setConnectPayoutDelay),
--     mirrored after Stripe accepted it. NULL = Stripe's default, which IS
--     `minimum` (the account country's floor). 0..365 is Firebase's accepted
--     range; Stripe enforces the country floor itself and refuses below it.
-- ----------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN connect_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (connect_enabled IN (0, 1));

ALTER TABLE tenants ADD COLUMN stripe_requirements_due_json TEXT CHECK (
  stripe_requirements_due_json IS NULL
  OR (
    length(stripe_requirements_due_json) <= 8192
    AND json_valid(stripe_requirements_due_json)
    AND json_type(stripe_requirements_due_json) = 'array'
    AND json_array_length(stripe_requirements_due_json) <= 50
  )
);

ALTER TABLE tenants ADD COLUMN stripe_disabled_reason TEXT CHECK (
  stripe_disabled_reason IS NULL
  OR (
    length(stripe_disabled_reason) BETWEEN 1 AND 64
    AND stripe_disabled_reason NOT GLOB '*[^a-z0-9_.]*'
  )
);

ALTER TABLE tenants ADD COLUMN payout_delay_days INTEGER CHECK (
  payout_delay_days IS NULL OR payout_delay_days BETWEEN 0 AND 365
);

-- A requirement list, a disabled reason or a payout delay without an account
-- is meaningless (the same reasoning as 0019's capability-flag triggers).
CREATE TRIGGER tenants_connect_facts_need_account_insert
BEFORE INSERT ON tenants
FOR EACH ROW
WHEN (NEW.stripe_requirements_due_json IS NOT NULL
      OR NEW.stripe_disabled_reason IS NOT NULL
      OR NEW.payout_delay_days IS NOT NULL)
  AND NEW.stripe_account_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'connect facts require a stripe account');
END;

CREATE TRIGGER tenants_connect_facts_need_account_update
BEFORE UPDATE ON tenants
FOR EACH ROW
WHEN (NEW.stripe_requirements_due_json IS NOT NULL
      OR NEW.stripe_disabled_reason IS NOT NULL
      OR NEW.payout_delay_days IS NOT NULL)
  AND NEW.stripe_account_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'connect facts require a stripe account');
END;


-- ----------------------------------------------------------------------------
-- connect_onboarding_ops — one row per attempt to create a shop's account.
--
-- RESERVE FIRST (the refunds / withholding-release pattern). The row is
-- written BEFORE Stripe is asked, and `op_id` IS the Stripe idempotency key:
-- a retry under the same key can only ever return the same account.
--
--   reserved ──► succeeded   Stripe returned the account; the SAME batch
--      │                     records it on the tenant, guarded
--      │                     `WHERE stripe_account_id IS NULL` (never an
--      │                     overwrite; a conflict raises an alert instead).
--      ├───────► failed      Stripe REFUSED (a 4xx). Stripe replays that
--      │                     refusal for 24 h under the same key, so the key
--      │                     is dead: the next request reserves a NEW op_id.
--      └───────► abandoned   The key is too old to retry safely (past the
--                            retry window, src/commerce/connect-onboarding.ts)
--                            and a complete listing of the platform's
--                            accounts found none carrying this tenant's
--                            metadata: nothing exists at Stripe, a new op may
--                            start.
--
--   A lost answer, a timeout, a 5xx, a 409/429 or a crash leave the row
--   `reserved`; the next request retries under the SAME key (Stripe replays
--   the account it created, or creates it now).
--
-- ONE reserved op per tenant (partial UNIQUE index): a concurrent second
-- request cannot reserve, it finds the first one's lease and waits.
--
--   attempts          create calls made under this key (>= 1: the reserving
--                     request makes the first).
--   lease_expires_at  while in the future, a request is talking to Stripe
--                     under this key and no other request may; NULL once
--                     settled.
--   business_name     the name sent with the FIRST create call, frozen: a
--                     retry under an idempotency key must send identical
--                     parameters, or Stripe answers with an idempotency error.
--   transition_id     the settling batch's nonce, so its audit/alert rows fire
--                     for exactly that transition.
--   error_code        a CODE, never Stripe prose.
-- ----------------------------------------------------------------------------
CREATE TABLE connect_onboarding_ops (
  op_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(op_id) BETWEEN 16 AND 64 AND op_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'succeeded', 'failed', 'abandoned')),
  stripe_account_id TEXT CHECK (
    stripe_account_id IS NULL
    OR (
      length(stripe_account_id) BETWEEN 6 AND 255
      AND substr(stripe_account_id, 1, 5) = 'acct_'
      AND stripe_account_id NOT GLOB '*[^A-Za-z0-9_]*'
    )
  ),
  accounts_api TEXT NOT NULL CHECK (accounts_api IN ('v1', 'v2')),
  business_name TEXT CHECK (business_name IS NULL OR length(business_name) BETWEEN 1 AND 200),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  lease_expires_at TEXT CHECK (
    lease_expires_at IS NULL
    OR lease_expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at)
  ),
  error_code TEXT CHECK (
    error_code IS NULL
    OR (length(error_code) BETWEEN 1 AND 100 AND error_code NOT GLOB '*[^A-Za-z0-9_.:-]*')
  ),
  transition_id TEXT CHECK (
    transition_id IS NULL
    OR (length(transition_id) BETWEEN 16 AND 64 AND transition_id NOT GLOB '*[^A-Za-z0-9_-]*')
  ),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  settled_at TEXT CHECK (
    settled_at IS NULL OR settled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', settled_at)
  ),
  CHECK (updated_at >= created_at),
  CHECK (settled_at IS NULL OR settled_at >= created_at),
  CHECK ((state = 'succeeded') = (stripe_account_id IS NOT NULL)),
  CHECK ((state = 'reserved') = (settled_at IS NULL)),
  CHECK (state = 'reserved' OR lease_expires_at IS NULL),
  CHECK (state NOT IN ('failed', 'abandoned') OR error_code IS NOT NULL)
);

-- At most ONE operation per tenant talks to Stripe at a time.
CREATE UNIQUE INDEX connect_onboarding_ops_one_reserved_idx
  ON connect_onboarding_ops(tenant_id) WHERE state = 'reserved';

-- The platform's history read, newest first.
CREATE INDEX connect_onboarding_ops_tenant_created_idx
  ON connect_onboarding_ops(tenant_id, created_at DESC);

-- Born reserved, holding nothing, and only for a shop the platform opted in
-- that has no account yet: a second account can never even be attempted.
CREATE TRIGGER connect_onboarding_ops_birth
BEFORE INSERT ON connect_onboarding_ops
FOR EACH ROW
WHEN NEW.state IS NOT 'reserved'
  OR NEW.stripe_account_id IS NOT NULL
  OR NEW.error_code IS NOT NULL
  OR NEW.settled_at IS NOT NULL
  OR NEW.transition_id IS NOT NULL
  OR NEW.attempts IS NOT 1
  OR NOT EXISTS (
    SELECT 1 FROM tenants AS t
    WHERE t.tenant_id = NEW.tenant_id
      AND t.connect_enabled = 1
      AND t.stripe_account_id IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'a connect onboarding operation is born reserved for an opted-in shop without an account');
END;

CREATE TRIGGER connect_onboarding_ops_identity_immutable
BEFORE UPDATE ON connect_onboarding_ops
FOR EACH ROW
WHEN NEW.op_id IS NOT OLD.op_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.accounts_api IS NOT OLD.accounts_api
  OR NEW.business_name IS NOT OLD.business_name
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.attempts < OLD.attempts
BEGIN
  SELECT RAISE(ABORT, 'connect onboarding operation identity is immutable');
END;

CREATE TRIGGER connect_onboarding_ops_state_machine
BEFORE UPDATE OF state ON connect_onboarding_ops
FOR EACH ROW
WHEN NEW.state IS NOT OLD.state
  AND NOT (OLD.state = 'reserved' AND NEW.state IN ('succeeded', 'failed', 'abandoned'))
BEGIN
  SELECT RAISE(ABORT, 'connect onboarding operation state transition is not allowed');
END;

-- Settled rows are final: nothing about them moves again.
CREATE TRIGGER connect_onboarding_ops_final_frozen
BEFORE UPDATE ON connect_onboarding_ops
FOR EACH ROW
WHEN OLD.state IN ('succeeded', 'failed', 'abandoned')
BEGIN
  SELECT RAISE(ABORT, 'connect onboarding operation is final');
END;

CREATE TRIGGER connect_onboarding_ops_no_delete
BEFORE DELETE ON connect_onboarding_ops
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'connect onboarding operations are append-only');
END;
