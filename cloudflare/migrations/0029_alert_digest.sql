PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP2-D2 — the alert digest email (DECISIONS D40).
--
-- Alerts (0017) are D1 rows a human must look at; until now nobody was told.
-- Every 15 minutes `runAlertDigest` (src/commerce/crons.ts) checks whether
-- unresolved alerts were raised since the last digest and, if so, sends ONE
-- email to the platform address (`PLATFORM_ALERT_EMAIL`) through the delivery
-- ledger + EMAIL_QUEUE, exactly like the order confirmation.
--
-- platform_state — ONE row (id = 1) of platform-wide bookkeeping.
--
--   last_digest_at       the `digest_computed_at` of the last digest handed
--                        to the queue: alerts created after it are "new".
--                        Only moves forward.
--   digest_bucket_start  the 15-minute bucket of the digest frozen below.
--   digest_computed_at   when its content was read.
--   digest_json          its content, FROZEN at the first build: a retried
--                        tick of the same bucket re-enqueues the identical
--                        job (same delivery id, same fingerprint) instead of
--                        re-reading alerts that may have changed, so the
--                        ledger sends it at most once and never refuses it as
--                        a fingerprint conflict.
--
-- TIME: ISO-8601 UTC TEXT (PLAN §2.8), the 0013/0014/0017 round-trip CHECK.
-- ============================================================================
CREATE TABLE platform_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  last_digest_at TEXT CHECK (
    last_digest_at IS NULL OR last_digest_at IS strftime('%Y-%m-%dT%H:%M:%fZ', last_digest_at)
  ),
  digest_bucket_start TEXT CHECK (
    digest_bucket_start IS NULL
    OR digest_bucket_start IS strftime('%Y-%m-%dT%H:%M:%fZ', digest_bucket_start)
  ),
  digest_computed_at TEXT CHECK (
    digest_computed_at IS NULL
    OR digest_computed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', digest_computed_at)
  ),
  digest_json TEXT CHECK (
    digest_json IS NULL
    OR (
      json_valid(digest_json)
      AND json_type(digest_json) = 'object'
      AND length(digest_json) <= 65536
    )
  ),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK ((digest_bucket_start IS NULL) = (digest_json IS NULL)),
  CHECK ((digest_bucket_start IS NULL) = (digest_computed_at IS NULL))
);

INSERT INTO platform_state (id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TRIGGER platform_state_no_delete
BEFORE DELETE ON platform_state
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'platform_state is a single permanent row');
END;

CREATE TRIGGER platform_state_digest_forward_only
BEFORE UPDATE OF last_digest_at ON platform_state
FOR EACH ROW
WHEN OLD.last_digest_at IS NOT NULL
  AND (NEW.last_digest_at IS NULL OR NEW.last_digest_at < OLD.last_digest_at)
BEGIN
  SELECT RAISE(ABORT, 'last_digest_at only moves forward');
END;

-- ============================================================================
-- email_deliveries: admit the 'alert_digest' kind.
--
-- Same recipe as 0022 (SQLite cannot ALTER a CHECK): the table is recreated
-- under the same name with the identical shape plus the new kind. Nothing
-- references it by foreign key. Every row is copied unchanged; the two
-- triggers and three indexes are re-declared exactly as 0022 declared them.
-- The digest's row has tenant_id NULL (a platform mail).
-- ============================================================================

CREATE TABLE email_deliveries_migration_0029 AS SELECT * FROM email_deliveries;

DROP TABLE email_deliveries;

CREATE TABLE email_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN (
    'email_verification', 'password_reset', 'order_confirmation', 'alert_digest'
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
FROM email_deliveries_migration_0029;

DROP TABLE email_deliveries_migration_0029;

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
