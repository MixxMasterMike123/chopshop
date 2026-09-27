PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP3-D — infringement reports: notice & takedown (SnapWear A10, DECISIONS
-- D58).
--
-- Ported from functions/src/infringement/submitInfringementReport.ts (the
-- writer) and takedownProduct.ts + src/pages/platform/PlatformReports.jsx (the
-- platform's handling). A rights holder reports a product from the shop's
-- storefront (POST /v1/reports, tenant = hostname); the report lands in the
-- PLATFORM's queue, never the shop's — the seller is the party being reported.
--
-- PERSONAL DATA: reporter_name, reporter_org and reporter_email are the
-- reporter's. They are read by platform routes only
-- (src/routes/platform-reports.ts) and never reach a tenant response, an
-- alert, an audit row or a log line. The reporter's IP is used as the intake
-- rate-limit key only (hashed by src/lib/rate-limit.ts) and is NOT stored here.
--
-- VALUES (Firebase):
--   right_type  'trademark' | 'copyright' | 'other'   (RIGHT_TYPES)
--   source      'storefront'                          (the only writer)
--   status      'new' → 'reviewing' | 'rejected' | 'taken_down';
--               'reviewing' → 'rejected' | 'taken_down';
--               'rejected' → 'reviewing' (PlatformReports "Öppna igen").
--               'taken_down' is final (reinstating the PRODUCT is a separate
--               platform decision; the report stays taken_down).
--               Enforced by infringement_reports_status_transition.
--
-- product_id is REQUIRED on Cloudflare (Firebase stored null for a report it
-- could not resolve): the intake refuses a product that is not the hostname
-- shop's, and a report's product is immutable. The product is never deleted
-- while reported (FK RESTRICT; a taken-down one additionally by
-- products_takedown_no_delete, 0025).
--
-- handled_by / handled_by_legacy_uid: the platform user who last handled the
-- report; an imported report whose handler is not a carried user keeps the
-- Firebase uid in handled_by_legacy_uid. At most one of the two is set.
--
-- version: bumped by every write; the handle and takedown writes target
-- `<read version> + 1`, so a write computed from a stale read trips
-- infringement_reports_version_monotonic and its whole batch rolls back.
--
-- Reports are evidence: append-only (no DELETE), facts immutable.
--
-- TIME: ISO-8601 UTC TEXT (PLAN §2.8), the 0013/0017/0029 round-trip CHECK.
-- ============================================================================

CREATE TABLE infringement_reports (
  report_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(report_id) BETWEEN 1 AND 128
    AND report_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The product's name when the report was filed (it may be renamed later).
  product_name TEXT CHECK (product_name IS NULL OR length(product_name) BETWEEN 1 AND 500),
  -- What the reporter pasted (a storefront link or a name), verbatim.
  product_url TEXT CHECK (product_url IS NULL OR length(product_url) BETWEEN 1 AND 1000),
  reporter_name TEXT NOT NULL CHECK (length(reporter_name) BETWEEN 1 AND 200),
  reporter_org TEXT CHECK (reporter_org IS NULL OR length(reporter_org) BETWEEN 1 AND 200),
  reporter_email TEXT NOT NULL CHECK (
    length(reporter_email) BETWEEN 3 AND 320 AND reporter_email LIKE '%_@_%'
  ),
  right_type TEXT NOT NULL CHECK (right_type IN ('trademark', 'copyright', 'other')),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 20 AND 5000),
  -- The reporter's good-faith statement; a report without it is never stored.
  attestation INTEGER NOT NULL CHECK (attestation = 1),
  status TEXT NOT NULL DEFAULT 'new' CHECK (
    status IN ('new', 'reviewing', 'rejected', 'taken_down')
  ),
  source TEXT NOT NULL DEFAULT 'storefront' CHECK (source IN ('storefront')),
  -- The platform's note (why it was rejected / taken down).
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  handled_by TEXT REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  handled_by_legacy_uid TEXT CHECK (
    handled_by_legacy_uid IS NULL OR length(handled_by_legacy_uid) BETWEEN 1 AND 128
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  handled_at TEXT CHECK (
    handled_at IS NULL OR handled_at IS strftime('%Y-%m-%dT%H:%M:%fZ', handled_at)
  ),
  CHECK (handled_by IS NULL OR handled_by_legacy_uid IS NULL),
  CHECK (handled_at IS NULL OR handled_at >= created_at),
  CHECK (
    status <> 'new'
    OR (handled_at IS NULL AND handled_by IS NULL AND handled_by_legacy_uid IS NULL)
  ),
  CHECK (status NOT IN ('rejected', 'taken_down') OR handled_at IS NOT NULL)
);

-- A report filed against shop A can only ever name a product of shop A.
CREATE TRIGGER infringement_reports_tenant_matches_product
BEFORE INSERT ON infringement_reports
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (SELECT tenant_id FROM products WHERE product_id = NEW.product_id)
BEGIN
  SELECT RAISE(ABORT, 'report tenant_id must match product tenant_id');
END;

CREATE TRIGGER infringement_reports_facts_immutable
BEFORE UPDATE ON infringement_reports
FOR EACH ROW
WHEN NEW.report_id IS NOT OLD.report_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.product_name IS NOT OLD.product_name
  OR NEW.product_url IS NOT OLD.product_url
  OR NEW.reporter_name IS NOT OLD.reporter_name
  OR NEW.reporter_org IS NOT OLD.reporter_org
  OR NEW.reporter_email IS NOT OLD.reporter_email
  OR NEW.right_type IS NOT OLD.right_type
  OR NEW.description IS NOT OLD.description
  OR NEW.attestation IS NOT OLD.attestation
  OR NEW.source IS NOT OLD.source
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'infringement report facts are immutable');
END;

CREATE TRIGGER infringement_reports_status_transition
BEFORE UPDATE OF status ON infringement_reports
FOR EACH ROW
WHEN NOT (
  (OLD.status = 'new' AND NEW.status IN ('reviewing', 'rejected', 'taken_down'))
  OR (OLD.status = 'reviewing' AND NEW.status IN ('rejected', 'taken_down'))
  OR (OLD.status = 'rejected' AND NEW.status = 'reviewing')
)
BEGIN
  SELECT RAISE(ABORT, 'infringement report status transition refused');
END;

CREATE TRIGGER infringement_reports_version_monotonic
BEFORE UPDATE OF version ON infringement_reports
FOR EACH ROW
WHEN NEW.version <= OLD.version
BEGIN
  SELECT RAISE(ABORT, 'infringement report version must increase');
END;

CREATE TRIGGER infringement_reports_no_delete
BEFORE DELETE ON infringement_reports
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'infringement reports are append-only');
END;

-- The platform queue: newest first, optionally by status or by shop.
CREATE INDEX infringement_reports_created_idx
  ON infringement_reports(created_at DESC, report_id DESC);
CREATE INDEX infringement_reports_status_created_idx
  ON infringement_reports(status, created_at DESC, report_id DESC);
CREATE INDEX infringement_reports_tenant_created_idx
  ON infringement_reports(tenant_id, created_at DESC, report_id DESC);
CREATE INDEX infringement_reports_product_idx ON infringement_reports(product_id);
