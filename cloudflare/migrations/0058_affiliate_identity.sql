PRAGMA foreign_keys = ON;

-- ============================================================================
-- 0058 — CP13 (the affiliate program), part 1: the identity kind, the feature
-- key and the mail kinds (docs/cf-port/CP13_AFFILIATE_DESIGN.md §1.1, §3.7,
-- §3.8, §9). The affiliate tables and the checkout/order columns are 0059.
--
-- 1. identity_access admits account_type 'affiliate' (design A1: an affiliate
--    is an identity on the ADMIN host with one `tenant_memberships` row of
--    role 'affiliate' per shop — a role 0002's CHECK already admits).
--
--    SQLite cannot alter a CHECK, so the table is rebuilt under the same name
--    (the 0050 recipe): copied, dropped, created with the widened CHECK and
--    0033's `status_change_id`, copied back column by column, and its one
--    index re-declared. What is attached to identity_access, verified from
--    every migration before writing this: 0002 creates the table and
--    `identity_access_type_status_idx`; 0033 adds `status_change_id`. No
--    trigger is declared on it, no view reads it, and NOTHING references it by
--    foreign key (every FK points at "user"), so the drop orphans nothing.
--    Every row is copied unchanged.
--
-- 2. tenant_features admits the key 'affiliate' (opt-in, design A12): the two
--    0032 allowlist triggers are replaced, as 0032 says a ported key comes
--    back. The list MUST equal FEATURE_KEYS in src/platform/tenant-config.ts
--    (test/tenant-features.test.ts pins the two together).
--
-- 3. email_deliveries admits the affiliate mails (design §9). The recipe of
--    0022/0029/0044/0050/0056 applied to the LATEST shape (0056, which added
--    `checkout_reminder`: it survives): recreated under the same name with
--    the identical shape plus the new kinds; every row copied unchanged; the
--    two triggers and three indexes re-declared exactly as 0056 declared
--    them. The invite of an affiliate who has not set a password is a
--    `password_reset` job (variant `affiliate_invite`, src/email/auth-email-job.ts)
--    and needs no kind of its own.
--
-- Safe on a database that holds rows: every copy is taken before its drop,
-- in the same migration.
-- ============================================================================

-- ── 1. identity_access ──────────────────────────────────────────────────────

CREATE TABLE identity_access_migration_0058 AS SELECT * FROM identity_access;

DROP TABLE identity_access;

CREATE TABLE identity_access (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  account_type TEXT NOT NULL CHECK (
    account_type IN ('ordinary', 'tenant_admin', 'platform_admin', 'print_operator', 'affiliate')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  status_change_id TEXT
);

INSERT INTO identity_access (
  user_id, account_type, status, created_at, updated_at, status_change_id
)
SELECT
  user_id, account_type, status, created_at, updated_at, status_change_id
FROM identity_access_migration_0058;

DROP TABLE identity_access_migration_0058;

CREATE INDEX identity_access_type_status_idx ON identity_access(account_type, status);

-- ── 2. tenant_features: the key 'affiliate' ─────────────────────────────────

DROP TRIGGER tenant_features_key_allowlist_insert;
DROP TRIGGER tenant_features_key_allowlist_update;

CREATE TRIGGER tenant_features_key_allowlist_insert
BEFORE INSERT ON tenant_features
FOR EACH ROW
WHEN NEW.feature_key NOT IN (
  'abandonedCheckout', 'affiliate', 'contentStudio', 'discountCodes',
  'marketingMaterials', 'pod', 'productReviews'
)
BEGIN
  SELECT RAISE(ABORT, 'feature_key is not an allowed feature');
END;

CREATE TRIGGER tenant_features_key_allowlist_update
BEFORE UPDATE OF feature_key ON tenant_features
FOR EACH ROW
WHEN NEW.feature_key NOT IN (
  'abandonedCheckout', 'affiliate', 'contentStudio', 'discountCodes',
  'marketingMaterials', 'pod', 'productReviews'
)
BEGIN
  SELECT RAISE(ABORT, 'feature_key is not an allowed feature');
END;

-- ── 3. email_deliveries: the affiliate kinds ────────────────────────────────
-- Every line below is 0056_checkout_reminders.sql's §5 except the kind list
-- and the copy's name.
--
--   affiliate_application_received  to the applicant (the apply batch)
--   affiliate_application_notice    to the shop's notice address (the apply batch)
--   affiliate_application_denied    to the applicant (the deny batch)
--   affiliate_welcome               to an affiliate who already has a password
--                                   (added to another shop; no link)
--   affiliate_conversion            to the affiliate (the order batch)
--   affiliate_reversal              to the affiliate (the refund / dispute batch)
--   affiliate_payout                to the affiliate (paid / void)
--   affiliate_payout_requested      to the shop (the request batch)

CREATE TABLE email_deliveries_migration_0058 AS SELECT * FROM email_deliveries;

DROP TABLE email_deliveries;

CREATE TABLE email_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN (
    'email_verification', 'password_reset', 'order_confirmation', 'alert_digest',
    'withdrawal_receipt', 'withdrawal_notice',
    'order_status_update', 'order_notice_shop', 'refund_notice',
    'checkout_reminder',
    'affiliate_application_received', 'affiliate_application_notice',
    'affiliate_application_denied', 'affiliate_welcome',
    'affiliate_conversion', 'affiliate_reversal',
    'affiliate_payout', 'affiliate_payout_requested'
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
FROM email_deliveries_migration_0058;

DROP TABLE email_deliveries_migration_0058;

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
