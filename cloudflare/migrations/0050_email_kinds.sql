PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP5-WE — the order mails on the Worker.
--
-- email_deliveries: admit three kinds.
--
--   order_status_update  to the buyer, when the seller moves the fulfilment
--                        (the `email.order_status` outbox rows of CP5-WB,
--                        src/commerce/fulfilment.ts);
--   order_notice_shop    to the shop, on a new paid order (one outbox row in
--                        the webhook's order batch);
--   refund_notice        to the buyer, when a refund SETTLES (one outbox row in
--                        the batch that moves its operation to 'succeeded').
--
-- The effects, the jobs and the templates: src/outbox/email-effect.ts,
-- src/email/order-emails.ts.
--
-- Same recipe as 0022, 0029 and 0044 (SQLite cannot ALTER a CHECK): the table
-- is recreated under the same name with the identical shape plus the three
-- kinds. Nothing references it by foreign key. Every row is copied unchanged
-- (column by column, named); the two triggers and three indexes are
-- re-declared exactly as 0044 declared them. Safe on a database that holds
-- rows: the copy is taken before the drop, in the same migration.
-- ============================================================================

CREATE TABLE email_deliveries_migration_0050 AS SELECT * FROM email_deliveries;

DROP TABLE email_deliveries;

CREATE TABLE email_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN (
    'email_verification', 'password_reset', 'order_confirmation', 'alert_digest',
    'withdrawal_receipt', 'withdrawal_notice',
    'order_status_update', 'order_notice_shop', 'refund_notice'
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
FROM email_deliveries_migration_0050;

DROP TABLE email_deliveries_migration_0050;

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
