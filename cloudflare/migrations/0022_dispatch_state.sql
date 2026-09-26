PRAGMA foreign_keys = ON;

-- ============================================================================
-- Dispatch state on the order line, order cancellation, and the order
-- confirmation email kind (PLAN §2.2, §2.3 "Dispatch state machine" and
-- "Cancellation vs dispatch").
--
-- The outbox row (0021) is the TRUTH of an effect; the columns below are the
-- line's READABLE projection of it, written in the same batch as every outbox
-- transition (src/dispatch/dispatch-effect.ts), so an admin reading an order
-- never needs to understand outbox internals.
--
-- CP2-A's 0019 adds `order_items.production_json` and
-- `orders.production_snapshot_json`; this migration reads neither and depends on
-- neither, so it applies whether or not 0019 is present.
-- ============================================================================

-- NULL = no dispatch recorded for this line: a non-POD line, or a POD line whose
-- dispatch row has not been claimed yet (the webhook inserts order_items without
-- knowing this column; the dispatcher writes 'submitting' at the first call).
--   pending     reserved for a writer that records the dispatch row's birth
--   submitting  the printer call is in flight (or was, and the worker died)
--   accepted    the printer has the job (accepted, or a duplicate job id)
--   unknown     the printer's answer was lost; resubmitting the same job id
--               is safe (duplicate = accepted), a human resolves after 30 min
--   failed      the printer refused it (or it could not be built) — a human looks
--   cancelled   cancelled before it reached the printer, or never accepted
ALTER TABLE order_items ADD COLUMN dispatch_state TEXT CHECK (
  dispatch_state IS NULL
  OR dispatch_state IN ('pending', 'submitting', 'accepted', 'unknown', 'failed', 'cancelled')
);

-- The printer's own reference for the accepted job (SnapWear's response id; the
-- fake printer's `id`). NULL for a job recognised as a duplicate, whose
-- original response — and so its id — was lost.
ALTER TABLE order_items ADD COLUMN printer_job_ref TEXT CHECK (
  printer_job_ref IS NULL OR length(printer_job_ref) BETWEEN 1 AND 200
);

ALTER TABLE order_items ADD COLUMN dispatched_at TEXT CHECK (
  dispatched_at IS NULL OR dispatched_at IS strftime('%Y-%m-%dT%H:%M:%fZ', dispatched_at)
);

-- Physical production, set by a platform route (print portal / manual, later).
-- 'produced' or 'shipped' makes a cancellation a RETURN CASE (§2.3): the
-- cancel route refuses with 409 and never acts automatically.
ALTER TABLE order_items ADD COLUMN production_state TEXT CHECK (
  production_state IS NULL OR production_state IN ('in_production', 'produced', 'shipped')
);

-- A dispatch fact, once reached, does not go back to "nothing happened".
CREATE TRIGGER order_items_dispatch_state_not_cleared
BEFORE UPDATE OF dispatch_state, printer_job_ref, dispatched_at ON order_items
FOR EACH ROW
WHEN (OLD.dispatch_state IS NOT NULL AND NEW.dispatch_state IS NULL)
  OR (OLD.printer_job_ref IS NOT NULL AND NEW.printer_job_ref IS NOT OLD.printer_job_ref)
  OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
BEGIN
  SELECT RAISE(ABORT, 'dispatch facts are one-way');
END;

CREATE INDEX order_items_tenant_dispatch_idx
  ON order_items(tenant_id, dispatch_state, order_id);

-- Order cancellation (POST /v1/admin/orders/:orderId/cancel). Recorded here and
-- in audit_events; it moves NO money (a refund is CP2-A's separate call) and it
-- does not move `orders.status`, whose refund transitions belong to CP2-A.
ALTER TABLE orders ADD COLUMN cancelled_at TEXT CHECK (
  cancelled_at IS NULL OR cancelled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at)
);

ALTER TABLE orders ADD COLUMN cancel_reason TEXT CHECK (
  cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 500
);

-- Write-once, and both together.
CREATE TRIGGER orders_cancellation_write_once
BEFORE UPDATE OF cancelled_at, cancel_reason ON orders
FOR EACH ROW
WHEN (OLD.cancelled_at IS NOT NULL
       AND (NEW.cancelled_at IS NOT OLD.cancelled_at OR NEW.cancel_reason IS NOT OLD.cancel_reason))
  OR ((NEW.cancelled_at IS NULL) IS NOT (NEW.cancel_reason IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'order cancellation is write-once');
END;

-- ============================================================================
-- email_deliveries: admit the 'order_confirmation' kind.
--
-- The ledger's `kind` CHECK (0003) names only the two auth kinds, and SQLite
-- cannot ALTER a CHECK, so the table is recreated under the same name with the
-- identical shape plus the new kind. Nothing references it by foreign key.
-- Every row is copied unchanged; the two triggers and three indexes are
-- re-declared exactly as 0003/0004 declared them.
-- ============================================================================

CREATE TABLE email_deliveries_migration_0022 AS SELECT * FROM email_deliveries;

DROP TABLE email_deliveries;

CREATE TABLE email_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('email_verification', 'password_reset', 'order_confirmation')),
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
FROM email_deliveries_migration_0022;

DROP TABLE email_deliveries_migration_0022;

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
