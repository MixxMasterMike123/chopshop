PRAGMA foreign_keys = ON;

-- This ledger intentionally stores no recipient address, action URL, or raw token.
CREATE TABLE email_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('email_verification', 'password_reset')),
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
  CHECK (attempts <= max_attempts),
  CHECK (expires_at > created_at),
  CHECK (status <> 'processing' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (status NOT IN ('sent', 'failed', 'expired') OR resolved_at IS NOT NULL)
);

CREATE TRIGGER email_deliveries_tenant_immutable
BEFORE UPDATE OF tenant_id ON email_deliveries
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE INDEX email_deliveries_due_idx ON email_deliveries(status, next_attempt_at);
CREATE INDEX email_deliveries_lease_idx ON email_deliveries(status, lease_until);
CREATE INDEX email_deliveries_tenant_created_idx ON email_deliveries(tenant_id, created_at DESC);
