PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP4-G — the withdrawal function (DAL 2 kap. 10 a §, CRD Art. 11a; in force
-- 19 June 2026; DECISIONS D96, D11, D46, D68).
--
-- Ported from the GUEST path of Firebase's `submitWithdrawal`
-- (functions/src/withdrawal/functions.ts). A buyer without an account states
-- the order number, the address the purchase was made with and a name on the
-- shop's own site (POST /v1/withdrawals, tenant = hostname). The server stamps
-- the time the message arrived, records it here, answers with the receipt
-- (mottagningsbevis) and mails it to the purchase address; the shop is told by
-- mail and in the admin order read. NO money moves and no order state changes:
-- the refund stays the shop's own action.
--
-- withdrawals — ONE row per order: the message and what the function answered.
--
--   eligible / reason     1 + NULL: the withdrawal covers the lines in
--                         withdrawn_items_json. 0 + a reason: the function
--                         answered that no right applies —
--                           'personalized_exempt'  every line of the order is
--                                                  personalised and its right
--                                                  was waived at checkout
--                                                  (orders.is_personalized +
--                                                  consent_json, D46);
--                           'window_passed'        the order is older than the
--                                                  absolute cap (450 days)
--                                                  after which no withdrawal
--                                                  period can still run.
--                         The answer is recorded either way: showing it is the
--                         function, and the time is the consumer's evidence.
--   withdrawn_items_json  the order's line indexes (order_items.item_index)
--   exempt_items_json     the withdrawal covers / the personalised lines whose
--                         right was waived. Frozen here, so the receipt of a
--                         second message is the first one's, whatever later
--                         code decides.
--   consumer_name,        what the buyer stated: the receipt names them. The
--   contact_email         address is the PURCHASE address (it must match the
--                         order's), stored as the buyer typed it, normalised.
--   shop_name             the shop's name when the message arrived (the
--                         receipt names the shop; tenants.shop_name is live).
--   shop_notice_email     the address the shop was told at (its support
--                         address then); NULL = the shop had none, and an
--                         alert was raised instead.
--   received_at           THE TIME OF RECEIPT, the server's. Written once.
--
-- PERSONAL DATA (D68): the name and the address are the buyer's. No visitor
-- address (IP) is stored: the IP is the intake rate limit's key only, hashed
-- with its scope by src/lib/rate-limit.ts. Erasure follows D68 (open).
--
-- APPEND-ONLY: no UPDATE, no DELETE, and a BEFORE INSERT guard that refuses a
-- second row for the same id or the same order — so `INSERT OR REPLACE`, which
-- would otherwise delete the first row without firing a DELETE trigger, can
-- never overwrite the first message or its time.
--
-- TIME: ISO-8601 UTC TEXT (PLAN §2.8), the 0013/0017/0029/0036 round-trip
-- CHECK.
-- ============================================================================

CREATE TABLE withdrawals (
  withdrawal_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(withdrawal_id) = 36 AND withdrawal_id NOT GLOB '*[^0-9a-f-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  reason TEXT CHECK (reason IS NULL OR reason IN ('personalized_exempt', 'window_passed')),
  withdrawn_items_json TEXT NOT NULL CHECK (
    json_valid(withdrawn_items_json)
    AND json_type(withdrawn_items_json) = 'array'
    AND length(withdrawn_items_json) <= 4096
  ),
  exempt_items_json TEXT NOT NULL CHECK (
    json_valid(exempt_items_json)
    AND json_type(exempt_items_json) = 'array'
    AND length(exempt_items_json) <= 4096
  ),
  consumer_name TEXT NOT NULL CHECK (length(consumer_name) BETWEEN 1 AND 200),
  contact_email TEXT NOT NULL CHECK (
    length(contact_email) BETWEEN 3 AND 254 AND contact_email LIKE '%_@_%'
  ),
  shop_name TEXT CHECK (shop_name IS NULL OR length(shop_name) BETWEEN 1 AND 200),
  shop_notice_email TEXT CHECK (
    shop_notice_email IS NULL
    OR (length(shop_notice_email) BETWEEN 3 AND 254 AND shop_notice_email LIKE '%_@_%')
  ),
  received_at TEXT NOT NULL CHECK (received_at IS strftime('%Y-%m-%dT%H:%M:%fZ', received_at)),
  -- A reason exactly when no right applies, and a refusal withdraws nothing.
  CHECK ((eligible = 1) = (reason IS NULL)),
  CHECK (eligible = 1 OR withdrawn_items_json = '[]')
);

-- A withdrawal filed through shop A's address can only ever name an order of
-- shop A.
CREATE TRIGGER withdrawals_tenant_matches_order
BEFORE INSERT ON withdrawals
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (SELECT tenant_id FROM orders WHERE order_id = NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'withdrawal tenant_id must match order tenant_id');
END;

-- The first message for an order is the one on record. A second INSERT for
-- the same id or the same order — plain, OR IGNORE or OR REPLACE — aborts
-- here, before any conflict resolution could delete the first row.
CREATE TRIGGER withdrawals_insert_once
BEFORE INSERT ON withdrawals
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM withdrawals
  WHERE withdrawal_id = NEW.withdrawal_id OR order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'withdrawals are append-only');
END;

CREATE TRIGGER withdrawals_no_update
BEFORE UPDATE ON withdrawals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'withdrawals are append-only');
END;

CREATE TRIGGER withdrawals_no_delete
BEFORE DELETE ON withdrawals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'withdrawals are append-only');
END;

-- The shop's list, newest first (the admin order read goes by order_id, which
-- the UNIQUE constraint indexes).
CREATE INDEX withdrawals_tenant_received_idx
  ON withdrawals(tenant_id, received_at DESC, withdrawal_id DESC);

-- ============================================================================
-- email_deliveries: admit the 'withdrawal_receipt' (to the buyer) and
-- 'withdrawal_notice' (to the shop) kinds.
--
-- Same recipe as 0022 and 0029 (SQLite cannot ALTER a CHECK): the table is
-- recreated under the same name with the identical shape plus the two kinds.
-- Nothing references it by foreign key. Every row is copied unchanged; the two
-- triggers and three indexes are re-declared exactly as 0029 declared them.
-- ============================================================================

CREATE TABLE email_deliveries_migration_0044 AS SELECT * FROM email_deliveries;

DROP TABLE email_deliveries;

CREATE TABLE email_deliveries (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN (
    'email_verification', 'password_reset', 'order_confirmation', 'alert_digest',
    'withdrawal_receipt', 'withdrawal_notice'
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
FROM email_deliveries_migration_0044;

DROP TABLE email_deliveries_migration_0044;

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
