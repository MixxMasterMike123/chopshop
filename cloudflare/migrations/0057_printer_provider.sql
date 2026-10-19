PRAGMA foreign_keys = ON;

-- ============================================================================
-- 0057 — the printer's PROVIDER (CP11, decision D1): which printer system a
-- printer row's jobs are submitted to. Before 0057 the environment decided
-- (the DISPATCH_TARGET var: "fake-printer" on staging, "snapwear" in
-- production); since 0057 the dispatcher reads the row of the printer the
-- order was routed to (orders.production_snapshot_json → printer → this
-- column) and builds that provider's client, if its gate passes
-- (src/dispatch/printer-client.ts resolveProviderClient).
--
--   snapwear  SnapWear's order API (production only; its own switch).
--   prodigi   Prodigi's v4 order API (sandbox on staging, live in production).
--   fake      the staging fake printer (/v1/staging/fake-printer/jobs).
--   manual    never submitted to: a print shop that is sent jobs by hand.
--
-- Which provider an `api` row may carry in which environment is the code's
-- (src/pod/printers.ts providerAllowedIn); the schema only keeps the
-- vocabulary and one coupling: a `manual` printer is never submitted to, so
-- its provider is `manual` (the trigger below). An `api` row MAY be `manual`:
-- that is what an api row this backfill does not recognise becomes, and the
-- dispatcher never submits to it (it parks the job, printer_not_configured,
-- and reconciliation's dispatch_stranded_30m names it) until a platform
-- operator sets its provider with PUT /v1/platform/printers.
--
-- SQLite accepts a CHECK on an added column whose default is a constant.
-- ============================================================================

ALTER TABLE printers ADD COLUMN provider TEXT NOT NULL DEFAULT 'manual' CHECK (
  provider IN ('snapwear', 'prodigi', 'fake', 'manual')
);

-- The backfill. The two api printers the platform has ever seeded keep the
-- dispatch they had through DISPATCH_TARGET: `snapwear` (production; the
-- importer's D12 row) and `fake-printer` (staging; scripts/cf-port/
-- seed-staging-slice.mjs). Every other row stays `manual` (the default): a
-- `manual` printer is that already, and an api row with any other id was
-- never dispatchable (the old code refused it as printer_mismatch).
--
-- These two UPDATEs fire catalog_version_printers_update (0025), which bumps
-- the catalogue version of every shop mapping to the printer: a cache
-- refresh, nothing more.
UPDATE printers SET provider = 'snapwear' WHERE id = 'snapwear' AND type = 'api';
UPDATE printers SET provider = 'fake' WHERE id = 'fake-printer' AND type = 'api';

-- A manual printer has no client: its provider is `manual`. Only the two
-- columns are watched, so an UPDATE of any other column (a deactivation, a
-- revision step) never trips on a row this migration left as it was.
CREATE TRIGGER printers_manual_provider_insert
BEFORE INSERT ON printers
FOR EACH ROW
WHEN NEW.type = 'manual' AND NEW.provider <> 'manual'
BEGIN
  SELECT RAISE(ABORT, 'a manual printer has the manual provider');
END;

CREATE TRIGGER printers_manual_provider_update
BEFORE UPDATE OF type, provider ON printers
FOR EACH ROW
WHEN NEW.type = 'manual' AND NEW.provider <> 'manual'
BEGIN
  SELECT RAISE(ABORT, 'a manual printer has the manual provider');
END;
