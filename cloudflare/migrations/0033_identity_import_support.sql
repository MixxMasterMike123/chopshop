PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP3-B — identity: import bookkeeping, lifecycle stamps, invites.
--
-- 1. IMPORT BOOKKEEPING (MIGRATION_MANIFEST §a, §d C5/C8). Three tables the
--    import scripts (scripts/cf-port/migrate/) write through SQL. No Worker
--    route reads or writes them, and none may expose them to a tenant session.
--
--    legacy_id_map      old id → new id, one row per carried identity. Append
--                       only: a mapping, once written, never changes.
--    import_runs        one row per applied import run. It starts `running`
--                       and ends `completed` or `failed`, after which it never
--                       changes again.
--    import_row_hashes  (table, primary key) → content hash of the row as
--                       imported. What makes a re-run idempotent: the same id
--                       with the same hash is skipped (INSERT OR IGNORE), the
--                       same id with a DIFFERENT hash aborts the statement,
--                       and with it the importer's batch.
--
--    REPLACE: SQLite resolves `INSERT OR REPLACE` / `UPDATE OR REPLACE` by
--    deleting the conflicting row WITHOUT firing delete triggers (D1 runs with
--    recursive_triggers off). An append-only table guarded only by BEFORE
--    UPDATE / BEFORE DELETE triggers can therefore still be rewritten by a
--    REPLACE. Each table below also refuses, in a BEFORE INSERT trigger, any
--    insert that would displace a row with different content.
--
-- 2. LIFECYCLE STAMPS. `status_change_id` on identity_access and
--    tenant_memberships: the id of the platform operation that last changed
--    the row's status. The deactivate / reactivate / revoke batches
--    (src/platform/user-lifecycle.ts) make ONE guarded UPDATE the decision and
--    key every other statement in the batch (audit row, session revocation,
--    invite revocation) on this stamp, so nothing is recorded or revoked for a
--    change that the guard refused.
--
-- 3. INVITES (src/platform/invites.ts). A platform operator issues a
--    password-set link for an identity. The token is a Better Auth reset token
--    (a `verification` row) with a 72-hour expiry; this table remembers which
--    `verification` row belongs to which invite, so a new invite can delete the
--    previous unused one, and deactivation can delete an outstanding one. At
--    most one invite per user is `issued` at a time.
--
-- TIME: the new tables use ISO-8601 UTC TEXT (PLAN §2.8) with the round-trip
-- CHECK of 0013/0014/0017/0031. identity_access and tenant_memberships keep
-- their INTEGER milliseconds.
-- ============================================================================

-- ── 1a. legacy_id_map ───────────────────────────────────────────────────────

CREATE TABLE legacy_id_map (
  -- Only identities that receive a NEW id are mapped. Printer ids, tenant ids
  -- and every other Firestore id are preserved verbatim (manifest §a, row 46)
  -- and never appear here. A new kind needs its own migration.
  kind TEXT NOT NULL CHECK (kind IN ('user')),
  legacy_id TEXT NOT NULL CHECK (length(legacy_id) BETWEEN 1 AND 256),
  new_id TEXT NOT NULL CHECK (length(new_id) BETWEEN 1 AND 256),
  env TEXT NOT NULL CHECK (env IN ('staging', 'production')),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  PRIMARY KEY (kind, legacy_id)
);

-- One new id belongs to one legacy id. D59 adoption (an imported user whose
-- mapped email already exists is mapped onto that existing user) still holds:
-- the adopted user is the target of exactly one legacy id.
CREATE UNIQUE INDEX legacy_id_map_new_id_idx ON legacy_id_map(kind, new_id);

CREATE TRIGGER legacy_id_map_no_update
BEFORE UPDATE ON legacy_id_map
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'legacy id map rows are append-only');
END;

CREATE TRIGGER legacy_id_map_no_delete
BEFORE DELETE ON legacy_id_map
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'legacy id map rows are append-only');
END;

-- The REPLACE guard. An insert whose key already exists must be the SAME row
-- (then INSERT OR IGNORE is a no-op); anything else is refused, including a
-- second legacy id claiming a new id that is already taken.
CREATE TRIGGER legacy_id_map_no_remap
BEFORE INSERT ON legacy_id_map
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM legacy_id_map
  WHERE kind = NEW.kind
    AND (
      (
        legacy_id = NEW.legacy_id
        AND (
          new_id IS NOT NEW.new_id
          OR env IS NOT NEW.env
          OR created_at IS NOT NEW.created_at
        )
      )
      OR (new_id = NEW.new_id AND legacy_id IS NOT NEW.legacy_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'legacy id map rows are append-only');
END;

-- ── 1b. import_runs ─────────────────────────────────────────────────────────

CREATE TABLE import_runs (
  run_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(run_id) BETWEEN 1 AND 128 AND run_id NOT GLOB '*[^0-9A-Za-z._:-]*'
  ),
  env TEXT NOT NULL CHECK (env IN ('staging', 'production')),
  -- Lowercase hex SHA-256 (C2 bundle, C4 plan).
  bundle_sha TEXT NOT NULL CHECK (length(bundle_sha) = 64 AND bundle_sha NOT GLOB '*[^0-9a-f]*'),
  plan_sha TEXT NOT NULL CHECK (length(plan_sha) = 64 AND plan_sha NOT GLOB '*[^0-9a-f]*'),
  started_at TEXT NOT NULL CHECK (started_at IS strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  finished_at TEXT CHECK (
    finished_at IS NULL
    OR (
      finished_at IS strftime('%Y-%m-%dT%H:%M:%fZ', finished_at)
      AND finished_at >= started_at
    )
  ),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  counts_json TEXT CHECK (
    counts_json IS NULL
    OR (json_valid(counts_json) AND json_type(counts_json) = 'object')
  ),
  -- A run is finished exactly when it carries a finish time.
  CHECK ((status = 'running') = (finished_at IS NULL))
);

-- At most one run in flight per environment. A run that crashed stays
-- `running` and blocks the next one until an operator closes it as `failed`
-- (allowed: a running run may still change).
CREATE UNIQUE INDEX import_runs_one_running_idx ON import_runs(env) WHERE status = 'running';

-- P2 "import once": at most one completed production run.
CREATE UNIQUE INDEX import_runs_production_once_idx
  ON import_runs(env) WHERE status = 'completed' AND env = 'production';

CREATE INDEX import_runs_env_started_idx ON import_runs(env, started_at DESC);

-- A run brackets its writes: it is inserted `running`, never pre-finished, and
-- a run id is never reused (which also refuses REPLACE of an existing run, and
-- of another run in flight whose unique index slot it would take).
CREATE TRIGGER import_runs_insert_guard
BEFORE INSERT ON import_runs
FOR EACH ROW
WHEN NEW.status IS NOT 'running'
  OR EXISTS (SELECT 1 FROM import_runs WHERE run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM import_runs WHERE env = NEW.env AND status = 'running')
  OR (
    NEW.env = 'production'
    AND EXISTS (
      SELECT 1 FROM import_runs WHERE env = 'production' AND status = 'completed'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'an import run starts running, once, one at a time');
END;

-- A completed or failed run never changes again.
CREATE TRIGGER import_runs_finished_immutable
BEFORE UPDATE ON import_runs
FOR EACH ROW
WHEN OLD.status IS NOT 'running'
BEGIN
  SELECT RAISE(ABORT, 'a finished import run is immutable');
END;

-- While running, only status, finished_at and counts_json may move.
CREATE TRIGGER import_runs_identity_immutable
BEFORE UPDATE ON import_runs
FOR EACH ROW
WHEN NEW.run_id IS NOT OLD.run_id
  OR NEW.env IS NOT OLD.env
  OR NEW.bundle_sha IS NOT OLD.bundle_sha
  OR NEW.plan_sha IS NOT OLD.plan_sha
  OR NEW.started_at IS NOT OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'an import run identity is immutable');
END;

-- UPDATE OR REPLACE could otherwise displace the one completed production run.
CREATE TRIGGER import_runs_production_once
BEFORE UPDATE OF status ON import_runs
FOR EACH ROW
WHEN NEW.status = 'completed'
  AND NEW.env = 'production'
  AND EXISTS (
    SELECT 1 FROM import_runs
    WHERE env = 'production' AND status = 'completed' AND run_id IS NOT NEW.run_id
  )
BEGIN
  SELECT RAISE(ABORT, 'production is imported once');
END;

CREATE TRIGGER import_runs_no_delete
BEFORE DELETE ON import_runs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'import runs are append-only');
END;

-- ── 1c. import_row_hashes ───────────────────────────────────────────────────

CREATE TABLE import_row_hashes (
  table_name TEXT NOT NULL CHECK (
    length(table_name) BETWEEN 1 AND 64 AND table_name NOT GLOB '*[^a-z0-9_]*'
  ),
  row_pk TEXT NOT NULL CHECK (length(row_pk) BETWEEN 1 AND 512),
  content_sha TEXT NOT NULL CHECK (
    length(content_sha) = 64 AND content_sha NOT GLOB '*[^0-9a-f]*'
  ),
  -- The run that FIRST recorded this row. A later run that finds the same
  -- content skips it (INSERT OR IGNORE) and leaves this value alone.
  run_id TEXT NOT NULL REFERENCES import_runs(run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  PRIMARY KEY (table_name, row_pk)
);

CREATE INDEX import_row_hashes_run_idx ON import_row_hashes(run_id);

-- C5: same id + different content aborts. Fires before the primary-key
-- conflict is resolved, so INSERT OR IGNORE cannot swallow a changed row.
CREATE TRIGGER import_row_hashes_same_content
BEFORE INSERT ON import_row_hashes
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM import_row_hashes
  WHERE table_name = NEW.table_name
    AND row_pk = NEW.row_pk
    AND content_sha IS NOT NEW.content_sha
)
BEGIN
  SELECT RAISE(ABORT, 'import row hash mismatch: same id, different content');
END;

-- Hashes are recorded only inside a run that is still in flight.
CREATE TRIGGER import_row_hashes_running_run
BEFORE INSERT ON import_row_hashes
FOR EACH ROW
WHEN (SELECT status FROM import_runs WHERE run_id = NEW.run_id) IS NOT 'running'
BEGIN
  SELECT RAISE(ABORT, 'import row hashes are recorded only by a running import run');
END;

CREATE TRIGGER import_row_hashes_no_update
BEFORE UPDATE ON import_row_hashes
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'import row hashes are append-only');
END;

CREATE TRIGGER import_row_hashes_no_delete
BEFORE DELETE ON import_row_hashes
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'import row hashes are append-only');
END;

-- ── 2. lifecycle stamps ─────────────────────────────────────────────────────

ALTER TABLE identity_access ADD COLUMN status_change_id TEXT;
ALTER TABLE tenant_memberships ADD COLUMN status_change_id TEXT;

-- ── 3. identity_invites ─────────────────────────────────────────────────────

CREATE TABLE identity_invites (
  invite_id TEXT PRIMARY KEY NOT NULL CHECK (length(invite_id) BETWEEN 1 AND 64),
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Which web surface the link lands on (platform admin → platform, tenant
  -- admin → admin); the origin itself comes from the canonical allowlist.
  surface TEXT NOT NULL CHECK (surface IN ('admin', 'platform')),
  status TEXT NOT NULL CHECK (status IN ('issued', 'superseded', 'revoked')),
  -- The Better Auth `verification` row holding the token's hash. Not a foreign
  -- key: Better Auth deletes that row when the token is used or expires.
  verification_id TEXT NOT NULL CHECK (length(verification_id) BETWEEN 1 AND 128),
  -- The email_deliveries row that carries the link.
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 64),
  issued_by TEXT NOT NULL REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  expires_at TEXT NOT NULL CHECK (expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND updated_at >= created_at
  ),
  CHECK (expires_at > created_at)
);

-- A new invite supersedes the previous one in the same batch; this makes two
-- live invites for one user impossible rather than merely unlikely.
CREATE UNIQUE INDEX identity_invites_one_issued_idx
  ON identity_invites(user_id) WHERE status = 'issued';

CREATE INDEX identity_invites_user_created_idx ON identity_invites(user_id, created_at DESC);

-- An invite moves once, from issued to superseded or revoked; nothing else on
-- the row changes, and the row is never deleted.
CREATE TRIGGER identity_invites_status_once
BEFORE UPDATE ON identity_invites
FOR EACH ROW
WHEN OLD.status IS NOT 'issued'
  OR NEW.status NOT IN ('superseded', 'revoked')
  OR NEW.invite_id IS NOT OLD.invite_id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.surface IS NOT OLD.surface
  OR NEW.verification_id IS NOT OLD.verification_id
  OR NEW.delivery_id IS NOT OLD.delivery_id
  OR NEW.issued_by IS NOT OLD.issued_by
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'an invite only moves from issued to superseded or revoked');
END;

CREATE TRIGGER identity_invites_no_delete
BEFORE DELETE ON identity_invites
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'invites are append-only');
END;
