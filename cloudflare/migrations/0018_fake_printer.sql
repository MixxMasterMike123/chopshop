PRAGMA foreign_keys = ON;

-- ============================================================================
-- The staging fake printer's inbox (PLAN §2.6 last sentence, §2.3 dispatch).
--
-- `POST /v1/staging/fake-printer/jobs` stands in for SnapWear's
-- `POST /api/order/add` on staging so the CP2 dispatch tests can prove "one
-- accepted printer job per eligible order" without a real print shop. Every
-- submission it ACCEPTS lands here, exactly once per `job_id` — the same
-- uniqueness SnapWear enforces (a duplicate `job_id` answers 400), which is what
-- makes the stable `{orderId}-{lineNo}` job id a safe retry key.
--
-- The route exists only when APP_ENV = 'staging' AND DISPATCH_TARGET =
-- 'fake-printer' (src/routes/fake-printer.ts). The table is created in every
-- environment because migrations are shared; in production nothing can write it.
-- ============================================================================
CREATE TABLE fake_printer_jobs (
  -- The fake printer's own id for the job, returned as `id` on acceptance —
  -- what a dispatcher records as the printer's reference.
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  job_id TEXT NOT NULL UNIQUE CHECK (length(job_id) BETWEEN 1 AND 128),
  -- Parsed out of job_id (`{orderId}-{lineNo}`) and required to exist: a
  -- submission for an order this database never created can only be a
  -- dispatcher bug, and the fake refuses it (422) rather than recording it.
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The body as received (after validation), for the tests to assert on.
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json)
    AND json_type(payload_json) = 'object'
    AND length(payload_json) <= 65536
  ),
  received_at TEXT NOT NULL CHECK (received_at IS strftime('%Y-%m-%dT%H:%M:%fZ', received_at))
);

CREATE TRIGGER fake_printer_jobs_tenant_immutable
BEFORE UPDATE OF tenant_id ON fake_printer_jobs
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- A received submission is a fact about what the dispatcher sent.
CREATE TRIGGER fake_printer_jobs_no_update
BEFORE UPDATE ON fake_printer_jobs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'fake printer jobs are write-once');
END;

-- The job belongs to the tenant of the order it names.
CREATE TRIGGER fake_printer_jobs_tenant_matches_order
BEFORE INSERT ON fake_printer_jobs
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM orders AS parent WHERE parent.order_id = NEW.order_id
)
BEGIN
  SELECT RAISE(ABORT, 'fake printer job must match its order tenant');
END;

CREATE INDEX fake_printer_jobs_tenant_received_idx
  ON fake_printer_jobs(tenant_id, received_at);
CREATE INDEX fake_printer_jobs_order_received_idx
  ON fake_printer_jobs(order_id, received_at, id);
