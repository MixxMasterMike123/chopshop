PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP7-T1 — import runs of two kinds (docs/cf-port/CP7_RUNBOOK.md §10 blocker 3).
--
-- 0033 let production complete ONE import run. The cutover imports in two
-- plans: the platform import (scripts/cf-port/migrate/import.mjs: tenants,
-- users, printers, settings) and, after the file copy, the catalogue
-- (import-catalogue.mjs: products, collections, pages, branding). The
-- catalogue plan needs the copy's manifest, and the copy needs the tenants of
-- the platform import, so the two cannot be one plan. With 0033 the second
-- one could never land.
--
-- `kind` names what a run imports:
--   platform    the CP3 plan. The default: a plan that does not name a kind
--               (import.mjs, restore-archive.mjs, every run recorded before
--               this migration) is a platform run.
--   catalogue   the catalogue plan, which names its kind in its first statement.
--
-- The rules, in production:
--   - at most one completed run PER KIND (0033: one in all);
--   - still one run in flight at a time per environment, whatever its kind;
--   - a catalogue run starts only after the platform run OF THE SAME EXPORT
--     (bundle_sha) has completed: its rows name that run's tenants and users,
--     and an export taken later would not be the frozen one (manifest §d P3);
--   - P2/P7: no run starts, and no run completes, once production holds an
--     order, a payment event or a checkout. 0033 left this to the operator.
-- A run's kind never changes, like the rest of its identity.
--
-- Staging keeps 0033's rules (one run in flight); its kinds are recorded and
-- not enforced. Existing rows become `platform`, including staging's catalogue
-- run of 2026-09-28 (its id starts with `catalogue_`; the tools read that
-- prefix as well as the kind). No finished row is rewritten.
-- ============================================================================

ALTER TABLE import_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'platform'
  CHECK (kind IN ('platform', 'catalogue'));

-- One completed production run per kind (the backstop of the insert guard).
DROP INDEX import_runs_production_once_idx;
CREATE UNIQUE INDEX import_runs_production_once_idx
  ON import_runs(env, kind) WHERE status = 'completed' AND env = 'production';

-- 0033's guard with the once-rule per kind. The message is 0033's: the plans'
-- apply.md and the tools' tests read it.
DROP TRIGGER import_runs_insert_guard;
CREATE TRIGGER import_runs_insert_guard
BEFORE INSERT ON import_runs
FOR EACH ROW
WHEN NEW.status IS NOT 'running'
  OR EXISTS (SELECT 1 FROM import_runs WHERE run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM import_runs WHERE env = NEW.env AND status = 'running')
  OR (
    NEW.env = 'production'
    AND EXISTS (
      SELECT 1 FROM import_runs
      WHERE env = 'production' AND kind = NEW.kind AND status = 'completed'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'an import run starts running, once, one at a time');
END;

CREATE TRIGGER import_runs_catalogue_after_platform
BEFORE INSERT ON import_runs
FOR EACH ROW
WHEN NEW.env = 'production'
  AND NEW.kind = 'catalogue'
  AND NOT EXISTS (
    SELECT 1 FROM import_runs
    WHERE env = 'production'
      AND kind = 'platform'
      AND status = 'completed'
      AND bundle_sha = NEW.bundle_sha
  )
BEGIN
  SELECT RAISE(ABORT, 'the catalogue is imported after the platform import of the same export');
END;

CREATE TRIGGER import_runs_production_no_orders_start
BEFORE INSERT ON import_runs
FOR EACH ROW
WHEN NEW.env = 'production'
  AND (
    EXISTS (SELECT 1 FROM orders)
    OR EXISTS (SELECT 1 FROM payment_events)
    OR EXISTS (SELECT 1 FROM checkouts)
  )
BEGIN
  SELECT RAISE(ABORT, 'production holds orders: nothing is imported after the first order');
END;

-- A run that was started before the first order is not completed after it
-- (manifest §d P2: a failed run is resumed only while P2 still holds).
CREATE TRIGGER import_runs_production_no_orders_finish
BEFORE UPDATE OF status ON import_runs
FOR EACH ROW
WHEN NEW.status = 'completed'
  AND NEW.env = 'production'
  AND (
    EXISTS (SELECT 1 FROM orders)
    OR EXISTS (SELECT 1 FROM payment_events)
    OR EXISTS (SELECT 1 FROM checkouts)
  )
BEGIN
  SELECT RAISE(ABORT, 'production holds orders: nothing is imported after the first order');
END;

-- 0033's UPDATE backstop, per kind.
DROP TRIGGER import_runs_production_once;
CREATE TRIGGER import_runs_production_once
BEFORE UPDATE OF status ON import_runs
FOR EACH ROW
WHEN NEW.status = 'completed'
  AND NEW.env = 'production'
  AND EXISTS (
    SELECT 1 FROM import_runs
    WHERE env = 'production'
      AND kind = NEW.kind
      AND status = 'completed'
      AND run_id IS NOT NEW.run_id
  )
BEGIN
  SELECT RAISE(ABORT, 'production is imported once');
END;

-- 0033's identity guard, with the kind.
DROP TRIGGER import_runs_identity_immutable;
CREATE TRIGGER import_runs_identity_immutable
BEFORE UPDATE ON import_runs
FOR EACH ROW
WHEN NEW.run_id IS NOT OLD.run_id
  OR NEW.env IS NOT OLD.env
  OR NEW.kind IS NOT OLD.kind
  OR NEW.bundle_sha IS NOT OLD.bundle_sha
  OR NEW.plan_sha IS NOT OLD.plan_sha
  OR NEW.started_at IS NOT OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'an import run identity is immutable');
END;
