PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP6-PS1 — the printer's production status on the order line.
--
-- `order_items.production_state` (0022: in_production | produced | shipped)
-- had no writer. It now has ONE: src/dispatch/production-status.ts
-- recordProductionStatus, called by POST /v1/platform/print-jobs/:jobId/status
-- (v1: the platform operator records what the printer's e-mail says; a later
-- automated source calls the same function).
--
-- THE PRINTER'S TRACKING, PER LINE. A printer job is ONE order line
-- ({orderId}-{lineNo}, PLAN §2.3), so each line can leave the printer in its
-- own parcel with its own tracking number. 0046's `order_shipments` is per
-- ORDER change and is read by the seller's order detail; these three columns
-- are per line and are read by NO tenant route (the seller's projection,
-- src/commerce/admin-orders.ts, selects named columns only). Whether the
-- seller and the buyer see the printer's tracking is a decision still owed
-- (docs/cf-port/CP6_PS1_REPORT.md).
--
-- BACKSTOPS (the code refuses first; these make a wrong writer abort):
--   - the production state never goes back and is never cleared;
--   - the tracking facts are written in the statement that moves the line to
--     'shipped', and never again.
-- Nothing else changes: no existing column, row or trigger is touched.
-- ============================================================================

ALTER TABLE order_items ADD COLUMN printer_tracking_number TEXT CHECK (
  printer_tracking_number IS NULL
  OR (length(printer_tracking_number) BETWEEN 1 AND 100
      AND instr(printer_tracking_number, char(10)) = 0
      AND instr(printer_tracking_number, char(13)) = 0)
);

ALTER TABLE order_items ADD COLUMN printer_carrier TEXT CHECK (
  printer_carrier IS NULL
  OR (length(printer_carrier) BETWEEN 1 AND 60
      AND instr(printer_carrier, char(10)) = 0
      AND instr(printer_carrier, char(13)) = 0)
);

ALTER TABLE order_items ADD COLUMN printer_tracking_url TEXT CHECK (
  printer_tracking_url IS NULL
  OR (length(printer_tracking_url) BETWEEN 9 AND 500
      AND substr(printer_tracking_url, 1, 8) = 'https://'
      AND instr(printer_tracking_url, char(10)) = 0
      AND instr(printer_tracking_url, char(13)) = 0
      AND instr(printer_tracking_url, ' ') = 0)
);

CREATE TRIGGER order_items_production_state_forward
BEFORE UPDATE OF production_state ON order_items
FOR EACH ROW
WHEN (CASE NEW.production_state
        WHEN 'in_production' THEN 1 WHEN 'produced' THEN 2 WHEN 'shipped' THEN 3 ELSE 0 END)
   < (CASE OLD.production_state
        WHEN 'in_production' THEN 1 WHEN 'produced' THEN 2 WHEN 'shipped' THEN 3 ELSE 0 END)
BEGIN
  SELECT RAISE(ABORT, 'production state only moves forward');
END;

CREATE TRIGGER order_items_printer_tracking_once
BEFORE UPDATE OF printer_tracking_number, printer_carrier, printer_tracking_url,
                 production_state ON order_items
FOR EACH ROW
WHEN (OLD.production_state IS 'shipped'
      AND (NEW.printer_tracking_number IS NOT OLD.printer_tracking_number
           OR NEW.printer_carrier IS NOT OLD.printer_carrier
           OR NEW.printer_tracking_url IS NOT OLD.printer_tracking_url))
  OR ((NEW.printer_tracking_number IS NOT NULL
       OR NEW.printer_carrier IS NOT NULL
       OR NEW.printer_tracking_url IS NOT NULL)
      AND NEW.production_state IS NOT 'shipped')
BEGIN
  SELECT RAISE(ABORT, 'printer tracking is written once, with the shipped state');
END;
