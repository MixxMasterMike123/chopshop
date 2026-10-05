PRAGMA foreign_keys = ON;

-- ============================================================================
-- 0056 — Övergiven kassa on Cloudflare (CP9-AC). ONE reminder e-mail to a
-- buyer who reached payment and left, only with consent, with a link that
-- rebuilds the cart (docs/cf-port/CP9_AC_REPORT.md).
--
-- Nothing on `checkouts` changes: a reminder must never move a checkout's
-- retention clock (src/commerce/crons.ts). No address is copied anywhere
-- here: the address stays on the checkout; these tables hold its sha256.
--
-- The decisions, the cron step and the mail: src/commerce/checkout-reminders.ts,
-- src/email/checkout-reminder-email.ts. The links: src/commerce/
-- checkout-recovery-token.ts (derived, never stored).
--
-- TIME: INTEGER epoch milliseconds, as checkouts and 0055.
-- ============================================================================

-- ── 1. The seller's switch ──────────────────────────────────────────────────
CREATE TABLE checkout_reminder_settings (
  tenant_id TEXT PRIMARY KEY NOT NULL
    REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  delay_hours INTEGER NOT NULL DEFAULT 1 CHECK (delay_hours BETWEEN 1 AND 24),
  -- When the switch was last turned ON. Only a checkout created at or after
  -- it is ever a candidate: turning the switch on mails nobody from before.
  -- Kept as it is when the switch is turned off.
  enabled_at INTEGER CHECK (enabled_at IS NULL OR enabled_at > 0),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  CHECK (enabled = 0 OR enabled_at IS NOT NULL)
);

CREATE TRIGGER checkout_reminder_settings_tenant_immutable
BEFORE UPDATE OF tenant_id ON checkout_reminder_settings
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- GET /v1/storefront's features.abandonedCheckout reads `enabled`, so a
-- change bumps the shop's catalog_version, as 0043 does for tenant_features.
CREATE TRIGGER catalog_version_checkout_reminder_settings_insert
AFTER INSERT ON checkout_reminder_settings
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_checkout_reminder_settings_update
AFTER UPDATE ON checkout_reminder_settings
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER checkout_reminder_settings_no_delete
BEFORE DELETE ON checkout_reminder_settings
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'checkout reminder settings are switched off, never deleted');
END;

-- ── 2. One decision per checkout ────────────────────────────────────────────
CREATE TABLE checkout_reminders (
  reminder_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(reminder_id) = 36 AND reminder_id NOT GLOB '*[^0-9a-f-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- UNIQUE: one decision per checkout, so at most one reminder per checkout.
  checkout_id TEXT NOT NULL UNIQUE
    REFERENCES checkouts(checkout_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- sha256 hex of the checkout's address as the checkout parser stored it
  -- (lower case, trimmed), = src/email/auth-email-job.ts hashEmailRecipient
  -- for every address a mail can go to, = the ledger's recipient_hash, =
  -- Firebase's emailHash. The cap and the unsubscribe key on it.
  buyer_hash TEXT NOT NULL CHECK (length(buyer_hash) = 64 AND buyer_hash NOT GLOB '*[^0-9a-f]*'),
  -- queued     an outbox row exists in the same batch; the mail is (being) built
  -- skipped    decided not to remind; `reason` says why
  -- withdrawn  queued, then the mail effect found a reason not to mail
  state TEXT NOT NULL CHECK (state IN ('queued', 'skipped', 'withdrawn')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'paid', 'feature_off', 'switch_off', 'orders_closed', 'no_consent',
    'undeliverable', 'unsubscribed', 'superseded', 'frequency_cap',
    'payment_failed', 'unavailable', 'payment_in_progress', 'intent_gone'
  )),
  decided_at INTEGER NOT NULL,
  -- The recovery link's end (decided_at + 7 days). NULL on a skipped row,
  -- for which no link was ever made.
  link_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((state = 'queued') = (reason IS NULL)),
  CHECK ((state = 'skipped') = (link_expires_at IS NULL)),
  CHECK (link_expires_at IS NULL OR link_expires_at > decided_at)
);

-- The decision belongs to a checkout of the same tenant.
CREATE TRIGGER checkout_reminders_match_checkout
BEFORE INSERT ON checkout_reminders
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM checkouts AS c
  WHERE c.checkout_id = NEW.checkout_id AND c.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'checkout reminder tenant must match its checkout');
END;

CREATE TRIGGER checkout_reminders_born
BEFORE INSERT ON checkout_reminders
FOR EACH ROW
WHEN NEW.state = 'withdrawn'
BEGIN
  SELECT RAISE(ABORT, 'a checkout reminder is born queued or skipped');
END;

-- THE CAP (AC6): at most one queued reminder per shop and address within
-- 7 days (604800000 ms = src/commerce/checkout-reminders.ts REMINDER_CAP_MS;
-- a test pins the two). Decided at the INSERT, so two cron runs racing for
-- one buyer cannot both queue: the batch that commits second is aborted
-- whole, its outbox row with it. The message is matched by the cron step.
CREATE TRIGGER checkout_reminders_cap
BEFORE INSERT ON checkout_reminders
FOR EACH ROW
WHEN NEW.state = 'queued' AND EXISTS (
  SELECT 1 FROM checkout_reminders AS r
  WHERE r.tenant_id = NEW.tenant_id
    AND r.buyer_hash = NEW.buyer_hash
    AND r.state = 'queued'
    AND r.decided_at > NEW.decided_at - 604800000
)
BEGIN
  SELECT RAISE(ABORT, 'checkout reminder frequency cap');
END;

-- The only move: queued → withdrawn, with a reason. Everything else frozen.
CREATE TRIGGER checkout_reminders_transition
BEFORE UPDATE ON checkout_reminders
FOR EACH ROW
WHEN NOT (OLD.state = 'queued' AND NEW.state = 'withdrawn' AND NEW.reason IS NOT NULL)
  OR NEW.reminder_id IS NOT OLD.reminder_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.checkout_id IS NOT OLD.checkout_id
  OR NEW.buyer_hash IS NOT OLD.buyer_hash
  OR NEW.decided_at IS NOT OLD.decided_at
  OR NEW.link_expires_at IS NOT OLD.link_expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'a checkout reminder only moves from queued to withdrawn');
END;

CREATE TRIGGER checkout_reminders_no_delete
BEFORE DELETE ON checkout_reminders
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'checkout reminders are append-only');
END;

CREATE INDEX checkout_reminders_cap_idx
  ON checkout_reminders(tenant_id, buyer_hash, state, decided_at);
CREATE INDEX checkout_reminders_tenant_decided_idx
  ON checkout_reminders(tenant_id, state, decided_at);

-- ── 3. Addresses that unsubscribed, per shop ────────────────────────────────
CREATE TABLE checkout_reminder_suppressions (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- sha256 hex of the lower-cased address: Firebase's emailHash
  -- (functions/src/checkout-recovery/tokens.ts), so an archived
  -- suppression carries over unchanged.
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64 AND email_hash NOT GLOB '*[^0-9a-f]*'),
  source TEXT NOT NULL CHECK (source IN ('unsubscribe', 'import')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, email_hash)
);

CREATE TRIGGER checkout_reminder_suppressions_no_update
BEFORE UPDATE ON checkout_reminder_suppressions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'checkout reminder suppressions are append-only');
END;

CREATE TRIGGER checkout_reminder_suppressions_no_delete
BEFORE DELETE ON checkout_reminder_suppressions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'checkout reminder suppressions are append-only');
END;

-- ── 4. The cron step's candidate read ───────────────────────────────────────
CREATE INDEX checkouts_status_created_idx ON checkouts(status, created_at);

-- ── 5. email_deliveries: admit 'checkout_reminder' ──────────────────────────
-- The recipe of 0022, 0029, 0044 and 0050 (SQLite cannot ALTER a CHECK): the
-- table is recreated under the same name with the identical shape plus the
-- one kind. Nothing references it by foreign key. Every row is copied
-- unchanged (column by column, named); the two triggers and three indexes
-- are re-declared exactly as 0050 declared them. Every line below is
-- 0050_email_kinds.sql's except the kind list and the copy's name.

CREATE TABLE email_deliveries_migration_0056 AS SELECT * FROM email_deliveries;

DROP TABLE email_deliveries;

CREATE TABLE email_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN (
    'email_verification', 'password_reset', 'order_confirmation', 'alert_digest',
    'withdrawal_receipt', 'withdrawal_notice',
    'order_status_update', 'order_notice_shop', 'refund_notice',
    'checkout_reminder'
  )),
  recipient_hash TEXT NOT NULL CHECK (length(recipient_hash) = 64),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  provider_message_id TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  last_error_code TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  job_fingerprint TEXT CHECK (
    job_fingerprint IS NULL OR length(job_fingerprint) = 64
  ),
  CHECK (attempts <= max_attempts),
  CHECK (expires_at > created_at),
  CHECK (status <> 'processing' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (status NOT IN ('sent', 'failed', 'expired') OR resolved_at IS NOT NULL)
);

INSERT INTO email_deliveries (
  delivery_id, tenant_id, kind, recipient_hash, status, attempts, max_attempts,
  next_attempt_at, lease_token, lease_until, provider_message_id, expires_at,
  last_error_code, resolved_at, created_at, updated_at, job_fingerprint
)
SELECT
  delivery_id, tenant_id, kind, recipient_hash, status, attempts, max_attempts,
  next_attempt_at, lease_token, lease_until, provider_message_id, expires_at,
  last_error_code, resolved_at, created_at, updated_at, job_fingerprint
FROM email_deliveries_migration_0056;

DROP TABLE email_deliveries_migration_0056;

CREATE TRIGGER email_deliveries_tenant_immutable
BEFORE UPDATE OF tenant_id ON email_deliveries
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER email_deliveries_fingerprint_required
BEFORE INSERT ON email_deliveries
FOR EACH ROW
WHEN NEW.job_fingerprint IS NULL OR length(NEW.job_fingerprint) <> 64
BEGIN
  SELECT RAISE(ABORT, 'job fingerprint is required');
END;

CREATE INDEX email_deliveries_due_idx ON email_deliveries(status, next_attempt_at);
CREATE INDEX email_deliveries_lease_idx ON email_deliveries(status, lease_until);
CREATE INDEX email_deliveries_tenant_created_idx ON email_deliveries(tenant_id, created_at DESC);
