PRAGMA foreign_keys = ON;

-- ============================================================================
-- The outbox with claims (PLAN §2.2, §2.3 "Dispatch state machine").
--
-- 0001 created `outbox_events` with a single-lease shape (`status` ∈ pending,
-- processing, sent, skipped, failed + lease_token/lease_until). §2.2 needs a
-- different state set and three facts the old table cannot hold:
--
--   pending → claimed → submitting → done | failed | superseded   (+ unknown)
--
--   claimed_by / claim_expires_at   the claim: a random token per claim and its
--                                   expiry. Every transition is fenced by BOTH,
--                                   so a stale worker's late completion is
--                                   rejected unless its token still holds.
--   cancel_requested                set by a cancellation while the row is in
--                                   flight; the consumer re-checks it after
--                                   claiming and again before the external call.
--   result_ref                      the external reference the effect produced
--                                   (the printer's job id, the email delivery id).
--
-- plus two facts the cancellation paths depend on:
--
--   submitted_at    first time the external call was ABOUT TO BE MADE. Once set
--                   it is never cleared (trigger): from then on the effect "may
--                   have reached the receiver", which is what separates a safe
--                   supersede from a human-action cancellation.
--   unknown_since   first time the external result was lost (`unknown`); the
--                   sweeper alerts when it is older than 30 minutes.
--
-- SQLite cannot ALTER a CHECK, so the table is recreated under the SAME name.
-- Nothing references outbox_events by foreign key, so the 0009 recipe shortens
-- to: snapshot → drop → create → copy (mapped) → drop snapshot → re-declare
-- triggers and indexes.
--
-- COLUMN CONTRACT (shared with CP2-A's webhook, which inserts dispatch + email
-- rows in the order batch): every 0001 column keeps its name and meaning —
-- `status` (not renamed to `state`), `next_attempt_at`, `attempts`,
-- `max_attempts`, `dedupe_key UNIQUE`, `last_error`. Columns are only ADDED.
-- The 0001 lease columns `lease_token` / `lease_until` stay (removing columns is
-- not allowed by the contract) but are RETIRED and pinned NULL: the claim lives
-- in claimed_by / claim_expires_at, and one source of truth for a claim is the
-- point of the fence.
--
-- STATUS MAP for rows written under 0001 (none exist on any environment today —
-- no code path ever wrote the table — but a migration that would silently drop
-- rows if that assumption were wrong is not worth running):
--   processing → claimed    (claimed_by ← lease_token, claim_expires_at ← lease_until)
--   sent       → done
--   skipped    → superseded
--   pending, failed          unchanged
--
-- TIME: this table keeps 0001's INTEGER epoch-milliseconds convention for every
-- timestamp (the brief: "outbox_events uses INTEGER ms — keep its convention").
-- ============================================================================

CREATE TABLE outbox_events_migration_0021 AS SELECT * FROM outbox_events;

DROP TABLE outbox_events;

CREATE TABLE outbox_events (
  outbox_id TEXT PRIMARY KEY NOT NULL CHECK (length(outbox_id) BETWEEN 1 AND 200),
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- 'dispatch' | 'email' | 'printer_cancellation' today. Deliberately not an
  -- enum CHECK: a new effect type must not need a table rebuild. The consumer
  -- claims only the types it knows, so an unknown type waits untouched.
  event_type TEXT NOT NULL CHECK (
    length(event_type) BETWEEN 1 AND 64 AND event_type NOT GLOB '*[^a-z0-9_.]*'
  ),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  -- The receiver-side idempotency key (PLAN §2.2): at most one row per effect.
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'claimed', 'submitting', 'done', 'failed', 'superseded', 'unknown'
  )),
  -- Claims started. Incremented by every claim; a claim is refused once it
  -- reaches max_attempts (so the CHECK below can never trip on a claim).
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  next_attempt_at INTEGER NOT NULL,
  -- RETIRED (see header): kept because columns are never removed, pinned NULL.
  lease_token TEXT CHECK (lease_token IS NULL),
  lease_until INTEGER CHECK (lease_until IS NULL),
  last_attempt_at INTEGER,
  resolved_at INTEGER,
  -- A CODE, never receiver text, a URL or personal data.
  last_error TEXT CHECK (
    last_error IS NULL
    OR (length(last_error) BETWEEN 1 AND 100 AND last_error NOT GLOB '*[^A-Za-z0-9_.:-]*')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  -- ── added by 0021 ──
  claimed_by TEXT CHECK (claimed_by IS NULL OR length(claimed_by) BETWEEN 16 AND 100),
  claim_expires_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  result_ref TEXT CHECK (result_ref IS NULL OR length(result_ref) BETWEEN 1 AND 200),
  submitted_at INTEGER,
  unknown_since INTEGER,
  CHECK (attempts <= max_attempts),
  -- A claim exists exactly while the row is claimed or submitting.
  CHECK (
    (status IN ('claimed', 'submitting'))
    = (claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  CHECK (status IN ('claimed', 'submitting') OR (claimed_by IS NULL AND claim_expires_at IS NULL)),
  -- Terminal ⇔ resolved.
  CHECK ((status IN ('done', 'failed', 'superseded')) = (resolved_at IS NOT NULL)),
  CHECK (status <> 'submitting' OR submitted_at IS NOT NULL),
  CHECK (status <> 'unknown' OR unknown_since IS NOT NULL)
);

INSERT INTO outbox_events (
  outbox_id, tenant_id, event_type, aggregate_type, aggregate_id, dedupe_key,
  payload_json, status, attempts, max_attempts, next_attempt_at, lease_token,
  lease_until, last_attempt_at, resolved_at, last_error, created_at, updated_at,
  claimed_by, claim_expires_at, cancel_requested, result_ref, submitted_at,
  unknown_since
)
SELECT
  outbox_id,
  tenant_id,
  event_type,
  aggregate_type,
  aggregate_id,
  dedupe_key,
  payload_json,
  CASE status
    WHEN 'processing' THEN 'claimed'
    WHEN 'sent' THEN 'done'
    WHEN 'skipped' THEN 'superseded'
    ELSE status
  END,
  attempts,
  max_attempts,
  next_attempt_at,
  NULL,
  NULL,
  last_attempt_at,
  CASE
    WHEN status IN ('sent', 'skipped', 'failed') THEN COALESCE(resolved_at, updated_at)
    ELSE NULL
  END,
  CASE
    WHEN last_error IS NULL THEN NULL
    WHEN length(last_error) BETWEEN 1 AND 100
      AND last_error NOT GLOB '*[^A-Za-z0-9_.:-]*' THEN last_error
    ELSE 'legacy_error'
  END,
  created_at,
  updated_at,
  CASE WHEN status = 'processing' THEN lease_token ELSE NULL END,
  CASE WHEN status = 'processing' THEN lease_until ELSE NULL END,
  0,
  NULL,
  NULL,
  NULL
FROM outbox_events_migration_0021;

DROP TABLE outbox_events_migration_0021;

CREATE TRIGGER outbox_events_tenant_immutable
BEFORE UPDATE OF tenant_id ON outbox_events
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- What the effect IS never changes after insert: a row that could be re-aimed
-- at another order or receiver would make the dedupe key a lie.
CREATE TRIGGER outbox_events_identity_immutable
BEFORE UPDATE ON outbox_events
FOR EACH ROW
WHEN NEW.outbox_id IS NOT OLD.outbox_id
  OR NEW.event_type IS NOT OLD.event_type
  OR NEW.aggregate_type IS NOT OLD.aggregate_type
  OR NEW.aggregate_id IS NOT OLD.aggregate_id
  OR NEW.dedupe_key IS NOT OLD.dedupe_key
  OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.max_attempts IS NOT OLD.max_attempts
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'outbox event identity is immutable');
END;

-- done and superseded are final: nothing about the row moves again.
CREATE TRIGGER outbox_events_final_frozen
BEFORE UPDATE ON outbox_events
FOR EACH ROW
WHEN OLD.status IN ('done', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'outbox event is final');
END;

-- The state machine, as an allowlist of edges. A same-status update (a re-claim
-- of an expired claim, a cancel_requested flag) is not an edge.
--   pending    → claimed | superseded (cancel before claim)
--   claimed    → submitting | pending (retry) | done | failed | superseded | unknown
--                | (re-claim after expiry is claimed → claimed)
--   submitting → claimed (re-claim after expiry) | pending | done | failed
--                | superseded | unknown
--   unknown    → claimed (automatic re-submit) | done | failed (manual resolution)
--   failed     → done (manual resolution: the printer did take it)
CREATE TRIGGER outbox_events_transition_allowed
BEFORE UPDATE OF status ON outbox_events
FOR EACH ROW
WHEN NEW.status IS NOT OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('claimed', 'superseded'))
  OR (OLD.status = 'claimed' AND NEW.status IN (
    'submitting', 'pending', 'done', 'failed', 'superseded', 'unknown'
  ))
  OR (OLD.status = 'submitting' AND NEW.status IN (
    'claimed', 'pending', 'done', 'failed', 'superseded', 'unknown'
  ))
  OR (OLD.status = 'unknown' AND NEW.status IN ('claimed', 'done', 'failed'))
  OR (OLD.status = 'failed' AND NEW.status = 'done')
)
BEGIN
  SELECT RAISE(ABORT, 'outbox transition not allowed');
END;

-- "May have reached the receiver" is a one-way fact, and so are a requested
-- cancellation, an unknown episode and the attempt count.
CREATE TRIGGER outbox_events_one_way_facts
BEFORE UPDATE ON outbox_events
FOR EACH ROW
WHEN (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS NOT OLD.submitted_at)
  OR (OLD.unknown_since IS NOT NULL AND NEW.unknown_since IS NOT OLD.unknown_since)
  OR NEW.cancel_requested < OLD.cancel_requested
  OR NEW.attempts < OLD.attempts
BEGIN
  SELECT RAISE(ABORT, 'outbox facts are one-way');
END;

CREATE INDEX outbox_events_due_idx ON outbox_events(status, next_attempt_at);
CREATE INDEX outbox_events_claim_idx ON outbox_events(status, claim_expires_at);
CREATE INDEX outbox_events_aggregate_idx ON outbox_events(aggregate_type, aggregate_id, created_at);
CREATE INDEX outbox_events_tenant_created_idx ON outbox_events(tenant_id, created_at DESC);
-- The platform dispatch list (GET /v1/platform/dispatch?state=…), cursor-paged.
CREATE INDEX outbox_events_type_status_idx ON outbox_events(event_type, status, created_at, outbox_id);
