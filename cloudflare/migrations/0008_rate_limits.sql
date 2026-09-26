PRAGMA foreign_keys = ON;

-- Fixed-window rate limit counters.
--
-- This table is disposable operational data and explicitly NOT an authorization
-- record. Nothing here grants, proves, or revokes access: it only slows a caller
-- down. That distinction is why it carries none of the machinery every other
-- table in this schema does — no tenant_id, no foreign keys, no immutability
-- trigger, no audit trail. Losing, truncating, or hand-editing this table costs
-- an operator nothing but a briefly wider limit, so guarding it like a ledger
-- would buy safety nobody needs and imply a durability promise it does not make.
--
-- No tenant column on purpose: the limits that matter here fire in front of
-- tenant resolution (the per-IP shield on an anonymous route, the shield in
-- front of the bootstrap token compare), so a tenant is not yet known and must
-- not be required. The scope string carries whatever partitioning a limit needs.
CREATE TABLE rate_limit_windows (
  -- Names the limit, e.g. 'checkout-ip', 'checkout-email', 'bootstrap-ip'. Part
  -- of the primary key so two limits never share a counter, and part of the
  -- hashed key below so a key observed under one scope cannot probe another.
  scope TEXT NOT NULL,
  -- SHA-256 hex of "{scope}:{caller key}". The raw key is NEVER stored: it is an
  -- IP address or an email address, both personal identifiers, and this table
  -- has no retention policy worth the name. Hashing keeps the counter exact
  -- while leaving nothing here to read back.
  key_hash TEXT NOT NULL CHECK (length(key_hash) = 64),
  -- Epoch ms floored to the window size. The window is identified by its start
  -- rather than a rolling timestamp so the counter is a pure upsert target.
  window_start INTEGER NOT NULL,
  -- Clamped app-side to a ceiling well below the integer range, so a sustained
  -- flood keeps counting without ever overflowing the column.
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (scope, key_hash, window_start)
-- WITHOUT ROWID: every access is a point lookup on the full primary key and the
-- row is three small columns plus timestamps, so storing it in the index b-tree
-- itself avoids a second lookup per limited request. Verified supported on D1,
-- secondary index below included.
) WITHOUT ROWID;

-- Cleanup only. Expired windows are swept opportunistically by the limiter
-- itself (a bounded DELETE fired when a fresh window opens), which keeps the
-- table bounded without a cron; this index is what makes that sweep cheap.
CREATE INDEX rate_limit_windows_window_start_idx ON rate_limit_windows(window_start);
