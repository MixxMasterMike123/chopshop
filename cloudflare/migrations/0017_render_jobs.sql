PRAGMA foreign_keys = ON;

-- ============================================================================
-- Render jobs with lease fencing (PLAN §2.6), and the platform `alerts` table.
--
-- The render farm no longer answers synchronously. Artwork creation inserts a
-- 'processing' pod_artwork row AND a 'queued' render_jobs row in one batch; the
-- farm PULLS work with `POST /v1/render/jobs/acquire`, writes its outputs to
-- ATTEMPT-SPECIFIC keys, and reports with `POST /v1/render/jobs/{id}/complete`
-- (or `/fail`). The row is the truth; a RENDER_JOBS_QUEUE message is only a
-- nudge.
--
-- FENCING. Every lease carries (attempt, lease token, lease_until). A report is
-- accepted only when all three still match: the attempt is the current one, the
-- token is the one minted for it, and the lease has not run out. An expired
-- lease is re-acquirable with attempt+1 and a NEW token, so a farm instance that
-- stalled past its lease can never complete a job someone else now holds — its
-- report is refused (409) and its attempt-specific outputs are swept. Outputs
-- never collide across attempts because each attempt writes under its own
-- `…/attempt-{n}/` prefix; only the winning attempt's verified bytes are
-- PROMOTED to the canonical keys the artwork row names.
--
-- THREE ATTEMPTS. The fourth acquisition of a job, or a failure report on the
-- third attempt, ends it: state 'failed', an `alerts` row, and the tenant's
-- 'processing' artwork row is removed so the same upload can simply be posted
-- again — the "replay is the retry" rule the synchronous path established.
--
-- TIME: ISO-8601 UTC TEXT written by the server (PLAN §2.8), the exact
-- Date.prototype.toISOString() shape, pinned by the same strftime round-trip
-- CHECK as 0013/0014 so the lexicographic lease comparisons stay chronological.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- render_jobs
--
--   queued     waiting for a farm. attempt = attempts already STARTED (0..2).
--   leased     a farm holds it: attempt 1..3, token hash and lease_until set.
--   completed  a fenced completion was accepted (the verdict may be ready OR
--              rejected — a gate rejection is a successful job).
--   failed     three attempts spent, the artwork was deleted, or the canonical
--              keys held different bytes. Terminal; `error` says which.
--
-- Terminal rows are frozen by trigger. Rows are DELETABLE (a retention sweep
-- will purge old terminal rows; nothing else references them).
-- ----------------------------------------------------------------------------
CREATE TABLE render_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  -- DELIBERATELY NOT A FOREIGN KEY. A job must outlive its artwork row: when an
  -- admin deletes a 'processing' artwork (or a terminal failure removes it) the
  -- job row stays behind as 'failed', which is what lets a farm that is still
  -- working on it be answered 409 and have its attempt outputs swept — both need
  -- the row's output_prefix. The tenant match is enforced at insert by trigger.
  artwork_id TEXT NOT NULL CHECK (length(artwork_id) BETWEEN 1 AND 64),

  -- The render version of the artwork. Artwork creation renders version 1; a
  -- future reprocess checkpoint enqueues version 2 under the same artwork id.
  version INTEGER NOT NULL CHECK (version >= 1),

  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'completed', 'failed')),

  -- SHA-256 hex of the current lease token. The raw token is returned once, to
  -- the farm that acquired the lease, and never stored.
  lease_token_hash TEXT CHECK (
    lease_token_hash IS NULL
    OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')
  ),
  lease_until TEXT CHECK (
    lease_until IS NULL OR lease_until IS strftime('%Y-%m-%dT%H:%M:%fZ', lease_until)
  ),

  -- The ORIGINAL the farm reads: the stored object's key, frozen at enqueue.
  -- Contained to the owning tenant's `shops/` prefix, byte-exactly (0006).
  input_key TEXT NOT NULL CHECK (
    substr(input_key, 1, length('shops/' || tenant_id || '/')) = 'shops/' || tenant_id || '/'
  ),
  -- The original's size at enqueue. The envelope's input.maxBytes is the
  -- tighter of this and the farm's ceiling (render-farm-client.ts).
  input_bytes INTEGER NOT NULL CHECK (input_bytes > 0),
  -- The five-field print profile (JobProfile) frozen at enqueue, so every
  -- attempt measures under the same specification even if the platform edits
  -- or retires the profile meanwhile — attempt 2 must be a replay of attempt 1.
  profile_json TEXT NOT NULL CHECK (
    json_valid(profile_json) AND json_type(profile_json) = 'object'
  ),
  -- Where attempt outputs go: `pod/{tenant}/render/{artwork}/{version}/`, and
  -- the attempt appends `attempt-{n}/`. Pinned exactly, so the prefix can only
  -- ever name this row's own tenant/artwork/version. `pod/` is the server-owned
  -- prefix no client-reachable route addresses (0012).
  output_prefix TEXT NOT NULL CHECK (
    output_prefix = 'pod/' || tenant_id || '/render/' || artwork_id || '/' || version || '/'
  ),

  -- The last error, as a CODE (never farm text, never a URL): the farm's
  -- contract keeps detail in its own logs keyed by job id.
  error TEXT CHECK (
    error IS NULL
    OR (length(error) BETWEEN 1 AND 100 AND error NOT GLOB '*[^A-Za-z0-9_.:-]*')
  ),

  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  completed_at TEXT CHECK (
    completed_at IS NULL OR completed_at IS strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)
  ),

  CHECK (updated_at >= created_at),
  CHECK (
    state <> 'queued'
    OR (attempt <= 2 AND lease_token_hash IS NULL AND lease_until IS NULL)
  ),
  CHECK (
    state <> 'leased'
    OR (attempt >= 1 AND lease_token_hash IS NOT NULL AND lease_until IS NOT NULL)
  ),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK (state <> 'completed' OR attempt >= 1),
  CHECK (state <> 'failed' OR error IS NOT NULL),

  -- One job per artwork render version: a second enqueue of the same version
  -- is a conflict, never a second concurrent render racing to the same keys.
  UNIQUE (artwork_id, version)
);

CREATE TRIGGER render_jobs_tenant_immutable
BEFORE UPDATE OF tenant_id ON render_jobs
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- What the job IS never changes after enqueue: which artwork, which version,
-- which input, which profile, where the outputs go.
CREATE TRIGGER render_jobs_identity_immutable
BEFORE UPDATE ON render_jobs
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.artwork_id IS NOT OLD.artwork_id
  OR NEW.version IS NOT OLD.version
  OR NEW.input_key IS NOT OLD.input_key
  OR NEW.input_bytes IS NOT OLD.input_bytes
  OR NEW.profile_json IS NOT OLD.profile_json
  OR NEW.output_prefix IS NOT OLD.output_prefix
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'render job identity is immutable');
END;

-- A terminal job is frozen: no revival, no second verdict, no re-lease.
CREATE TRIGGER render_jobs_terminal_is_final
BEFORE UPDATE ON render_jobs
FOR EACH ROW
WHEN OLD.state IN ('completed', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'render job is terminal');
END;

-- Attempts only count up; a lease can never be rewound onto an older attempt,
-- which is what makes "attempt == current" a fence.
CREATE TRIGGER render_jobs_attempt_monotonic
BEFORE UPDATE OF attempt ON render_jobs
FOR EACH ROW
WHEN NEW.attempt < OLD.attempt
BEGIN
  SELECT RAISE(ABORT, 'render job attempt cannot decrease');
END;

-- Nothing completes without having been leased.
CREATE TRIGGER render_jobs_complete_requires_lease
BEFORE UPDATE OF state ON render_jobs
FOR EACH ROW
WHEN OLD.state = 'queued' AND NEW.state = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'render job must be leased before it completes');
END;

-- The artwork must exist and belong to the job's tenant when the job is made.
CREATE TRIGGER render_jobs_artwork_tenant_matches
BEFORE INSERT ON render_jobs
FOR EACH ROW
WHEN (
  SELECT tenant_id FROM pod_artwork WHERE artwork_id = NEW.artwork_id
) IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'render job artwork must belong to the same tenant');
END;

CREATE INDEX render_jobs_tenant_created_idx ON render_jobs(tenant_id, created_at DESC);
-- The acquire query: oldest acquirable first.
CREATE INDEX render_jobs_state_created_idx ON render_jobs(state, created_at, id);
-- Expired-lease reaping.
CREATE INDEX render_jobs_state_lease_idx ON render_jobs(state, lease_until);


-- ----------------------------------------------------------------------------
-- alerts — work a human must look at (PLAN §2.2: stranded work, exhausted
-- retries, conditions the code refuses to resolve on its own).
--
-- tenant_id is NULL for platform-wide conditions. An alert's facts are fixed
-- when it is raised; the only change is resolving it, once. Alerts are never
-- deleted: they are the record that something needed a person.
--
-- A writer that can raise the same condition twice uses a DETERMINISTIC id
-- (e.g. 'render-job-failed:{jobId}'), so the primary key is the dedupe.
-- ----------------------------------------------------------------------------
CREATE TABLE alerts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (
    length(kind) BETWEEN 1 AND 64 AND kind NOT GLOB '*[^a-z0-9_.]*'
  ),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  -- Operator-facing text. Writers put ids and codes here, never URLs, tokens
  -- or personal data.
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  resource_type TEXT CHECK (resource_type IS NULL OR length(resource_type) BETWEEN 1 AND 64),
  resource_id TEXT CHECK (resource_id IS NULL OR length(resource_id) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  resolved_at TEXT CHECK (
    resolved_at IS NULL OR resolved_at IS strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at)
  ),
  CHECK ((resource_type IS NULL) = (resource_id IS NULL)),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE TRIGGER alerts_tenant_immutable
BEFORE UPDATE OF tenant_id ON alerts
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER alerts_facts_immutable
BEFORE UPDATE ON alerts
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.severity IS NOT OLD.severity
  OR NEW.message IS NOT OLD.message
  OR NEW.resource_type IS NOT OLD.resource_type
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'alert facts are immutable');
END;

CREATE TRIGGER alerts_resolution_final
BEFORE UPDATE OF resolved_at ON alerts
FOR EACH ROW
WHEN OLD.resolved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'alert resolution is final');
END;

CREATE TRIGGER alerts_no_delete
BEFORE DELETE ON alerts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'alerts are append-only');
END;

CREATE INDEX alerts_tenant_created_idx ON alerts(tenant_id, created_at DESC);
-- The open-alerts view the reconciliation cron and the platform UI will read.
CREATE INDEX alerts_open_idx ON alerts(resolved_at, created_at);
CREATE INDEX alerts_resource_idx ON alerts(resource_type, resource_id);
