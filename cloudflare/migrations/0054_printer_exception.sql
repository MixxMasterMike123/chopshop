PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP6-PS3 (LAUNCH_TODO A7) — the printer's exception on an ACCEPTED line.
--
-- The printer accepts a job (one order line), SnapWear's auto-pay charges it,
-- and the printer may later write that the blank is out of stock. These two
-- columns record that and a human's closing of it. Their ONE writer is
-- src/dispatch/production-status.ts recordProductionStatus (the platform route
-- POST /v1/platform/print-jobs/:jobId/status); no tenant route selects them.
--
--   printer_exception              'out_of_stock': what the printer reported.
--                                  A fact — written once, never cleared.
--   printer_exception_resolved_at  a platform operator closed the exception
--                                  WITHOUT the printer sending the line (it
--                                  will not be made; the shop and the buyer
--                                  were settled with by hand). Written once.
--
-- What they change elsewhere: an exception line that is neither shipped nor
-- resolved holds the order's fulfilment back like any unsent printer line; a
-- resolved one does not (src/commerce/fulfilment.ts unsentPodLinesSql). The
-- seller reads the existing word `failed` (src/commerce/admin-orders.ts). No
-- money is read from them: an accepted line's production withholding stays
-- where it was (src/commerce/withholding-release.ts releasableSql).
--
-- BACKSTOPS (the code refuses first; these make a wrong writer abort):
--   - no line is born with either column set;
--   - the exception is set only on a printer line the printer accepted that is
--     not produced or shipped, and is never changed or cleared;
--   - the resolution is set only on a line with the exception that is not
--     shipped, and is never changed or cleared;
--   - a line with an exception moves its production state only to 'shipped'
--     (the printer restocked and sent it), and a resolved one not at all.
-- Nothing else changes: no existing column, row or trigger is touched.
-- ============================================================================

ALTER TABLE order_items ADD COLUMN printer_exception TEXT CHECK (
  printer_exception IS NULL OR printer_exception = 'out_of_stock'
);

ALTER TABLE order_items ADD COLUMN printer_exception_resolved_at TEXT CHECK (
  printer_exception_resolved_at IS NULL
  OR printer_exception_resolved_at IS strftime('%Y-%m-%dT%H:%M:%fZ', printer_exception_resolved_at)
);

CREATE TRIGGER order_items_printer_exception_not_at_insert
BEFORE INSERT ON order_items
FOR EACH ROW
WHEN NEW.printer_exception IS NOT NULL OR NEW.printer_exception_resolved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a printer exception is recorded on an accepted line, never at insert');
END;

CREATE TRIGGER order_items_printer_exception_once
BEFORE UPDATE OF printer_exception ON order_items
FOR EACH ROW
WHEN (OLD.printer_exception IS NOT NULL AND NEW.printer_exception IS NOT OLD.printer_exception)
  OR (OLD.printer_exception IS NULL AND NEW.printer_exception IS NOT NULL
      AND (NEW.production_json IS NULL
           OR NEW.dispatch_state IS NOT 'accepted'
           OR NEW.production_state IS 'produced'
           OR NEW.production_state IS 'shipped'))
BEGIN
  SELECT RAISE(ABORT, 'a printer exception is written once, on an accepted line not yet produced');
END;

CREATE TRIGGER order_items_printer_exception_resolved_once
BEFORE UPDATE OF printer_exception_resolved_at ON order_items
FOR EACH ROW
WHEN (OLD.printer_exception_resolved_at IS NOT NULL
      AND NEW.printer_exception_resolved_at IS NOT OLD.printer_exception_resolved_at)
  OR (OLD.printer_exception_resolved_at IS NULL AND NEW.printer_exception_resolved_at IS NOT NULL
      AND (NEW.printer_exception IS NULL OR NEW.production_state IS 'shipped'))
BEGIN
  SELECT RAISE(ABORT, 'a printer exception is resolved once, on a line the printer has not sent');
END;

CREATE TRIGGER order_items_printer_exception_production
BEFORE UPDATE OF production_state ON order_items
FOR EACH ROW
WHEN NEW.printer_exception IS NOT NULL
 AND NEW.production_state IS NOT OLD.production_state
 AND (NEW.production_state IS NOT 'shipped' OR NEW.printer_exception_resolved_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a line with a printer exception moves only to shipped, and a resolved one not at all');
END;
