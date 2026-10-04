-- 0053 — CP6-PS2 (LAUNCH_TODO A5): the print canvas per order line and slot.
--
-- When the canvas switch is on (PRINT_CANVAS_ENABLED, src/dispatch/print-canvas.ts),
-- the printer receives, per print slot of a line, a PNG of the printer's whole
-- frame with the motif placed in it, instead of the bare motif. The render
-- container makes it; this table is both its job queue (leases, fenced exactly
-- as render_jobs, 0017) and the RECORD the dispatcher verifies the bytes against
-- (canvas_sha256, compared with R2's own sha256 of canvas_key).
--
-- Why not render_jobs: its CHECKs pin the input to `shops/{tenant}/` and the
-- output to the artwork's render prefix, it is UNIQUE per artwork version, and
-- its terminal path deletes a 'processing' artwork row. SQLite cannot relax a
-- CHECK without rebuilding the table.
--
-- ONE canvas per (order line, slot), ever: UNIQUE below, a settled row is final,
-- a row is never deleted or replaced, and the canonical object is written
-- create-if-absent with R2 verifying the sha256 (src/pod/print-canvas-jobs.ts).
-- No money, no cost, no seller-readable route selects this table.

PRAGMA foreign_keys = ON;

CREATE TABLE print_canvas_jobs (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  -- SnapWear prints front and back only (layouts[].location).
  slot TEXT NOT NULL CHECK (slot IN ('front', 'back')),

  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'completed', 'failed')),
  lease_token_hash TEXT CHECK (
    lease_token_hash IS NULL
    OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')
  ),
  lease_until TEXT CHECK (
    lease_until IS NULL OR lease_until IS strftime('%Y-%m-%dT%H:%M:%fZ', lease_until)
  ),

  -- The artwork's print master the line froze at checkout (key + sha256).
  input_key TEXT NOT NULL CHECK (
    substr(input_key, 1, length('pod/' || tenant_id || '/print/')) = 'pod/' || tenant_id || '/print/'
  ),
  input_sha256 TEXT NOT NULL CHECK (
    length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  input_bytes INTEGER NOT NULL CHECK (input_bytes > 0),
  -- The geometry, computed once by the Worker and frozen: every attempt renders
  -- the same canvas even if the platform's constants change meanwhile.
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json) AND json_type(spec_json) = 'object'),
  -- Attempt outputs go to `{output_prefix}attempt-{n}/canvas.png`.
  output_prefix TEXT NOT NULL CHECK (
    output_prefix = 'pod/' || tenant_id || '/render/canvas/' || order_id || '/' || line_no || '/' || slot || '/'
  ),
  -- The canonical canvas: under the order, in the shop's server-owned print path.
  canvas_key TEXT NOT NULL CHECK (
    canvas_key = 'pod/' || tenant_id || '/print/orders/' || order_id || '/' || line_no || '-' || slot || '.png'
  ),
  canvas_sha256 TEXT CHECK (
    canvas_sha256 IS NULL OR (length(canvas_sha256) = 64 AND canvas_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  canvas_bytes INTEGER CHECK (canvas_bytes IS NULL OR canvas_bytes > 0),

  -- A CODE, never container text or a URL.
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
  CHECK ((state = 'completed') = (canvas_sha256 IS NOT NULL AND canvas_bytes IS NOT NULL)),
  CHECK (state <> 'completed' OR attempt >= 1),
  CHECK (state <> 'failed' OR error IS NOT NULL),
  UNIQUE (tenant_id, order_id, line_no, slot)
);

-- acquire: the oldest queued job, or a leased one whose lease ran out.
CREATE INDEX print_canvas_jobs_acquire_idx ON print_canvas_jobs (state, created_at, id);

-- The row belongs to a real line of an order of THIS tenant (the FK proves the
-- order exists; this proves the tenant and the line: lineNo = item_index + 1).
CREATE TRIGGER print_canvas_jobs_line_exists
BEFORE INSERT ON print_canvas_jobs
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM order_items
  WHERE order_id = NEW.order_id
    AND tenant_id = NEW.tenant_id
    AND item_index = NEW.line_no - 1
)
BEGIN
  SELECT RAISE(ABORT, 'a canvas job names a line of an order of its own tenant');
END;

-- One row per (line, slot), and a second insert is a no-op, whatever its verb:
-- RAISE(IGNORE) runs before conflict resolution, so INSERT OR REPLACE (which
-- would DELETE the settled row and its record) and an upsert's DO UPDATE are
-- abandoned like a plain INSERT OR IGNORE. The first row stands.
CREATE TRIGGER print_canvas_jobs_insert_once
BEFORE INSERT ON print_canvas_jobs
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM print_canvas_jobs
  WHERE id = NEW.id
     OR (tenant_id = NEW.tenant_id AND order_id = NEW.order_id
         AND line_no = NEW.line_no AND slot = NEW.slot)
)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- What a job renders, from what, and where it lands never changes.
CREATE TRIGGER print_canvas_jobs_identity_immutable
BEFORE UPDATE OF id, tenant_id, order_id, line_no, slot, input_key, input_sha256,
                 input_bytes, spec_json, output_prefix, canvas_key, created_at
ON print_canvas_jobs
FOR EACH ROW
WHEN OLD.id IS NOT NEW.id
  OR OLD.tenant_id IS NOT NEW.tenant_id
  OR OLD.order_id IS NOT NEW.order_id
  OR OLD.line_no IS NOT NEW.line_no
  OR OLD.slot IS NOT NEW.slot
  OR OLD.input_key IS NOT NEW.input_key
  OR OLD.input_sha256 IS NOT NEW.input_sha256
  OR OLD.input_bytes IS NOT NEW.input_bytes
  OR OLD.spec_json IS NOT NEW.spec_json
  OR OLD.output_prefix IS NOT NEW.output_prefix
  OR OLD.canvas_key IS NOT NEW.canvas_key
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'a canvas job''s identity is immutable');
END;

-- A settled job is final: a completed canvas is the line's file for good (a
-- re-dispatch reuses it), and a failed one stays failed (a human places it).
CREATE TRIGGER print_canvas_jobs_settled_final
BEFORE UPDATE ON print_canvas_jobs
FOR EACH ROW
WHEN OLD.state IN ('completed', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'a settled canvas job is final');
END;

-- Never deleted: the record is what dispatch verifies a reprint's bytes against.
CREATE TRIGGER print_canvas_jobs_never_deleted
BEFORE DELETE ON print_canvas_jobs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'a canvas job is never deleted');
END;
