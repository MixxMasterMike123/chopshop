PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP3-C — the platform side of printers: the default printer, the supplier
-- catalogue, and the revision fence a partial printer edit needs.
--
-- SSOT: docs/cf-port/CP3_GAP_ANALYSIS.md §1c; DECISIONS D12, D52, D59.
-- Report: docs/cf-port/CP3_C_REPORT.md.
--
-- ADDITIVE ONLY: two new tables, one new column on `printers`, triggers.
--
-- TIME: ISO-8601 UTC TEXT in the exact Date.prototype.toISOString() shape,
-- pinned by the strftime round-trip CHECK 0013/0023/0029 use.
-- ACTORS: `updated_by` / `imported_by` hold a user id (or an importer's marker)
-- WITHOUT a foreign key, like `audit_events.actor_user_id` and
-- `product_screening.decided_by`: the audit row is the record, and an import
-- run may write rows before (or without) the matching user.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- print_defaults — ONE row (id = 1): the platform's default printer.
--
-- The Firebase `settings/printRouting` document routed by garment with a
-- `defaultPrinterUid` fallback. On Cloudflare a POD mapping names its printer
-- and printer SKU directly, so there is NO garment → printer routing table
-- (D52); only the default survives. Nothing in the Worker consumes it yet: it
-- is stored for the importer's verification and for the studio (CP6) to
-- preselect a printer.
--
--   default_printer_id  NULL = no default. When set it names an existing
--                       PLATFORM printer (FK + trigger below). "Active" is
--                       checked by the write route at the time of writing,
--                       deliberately not by the schema: the importer carries
--                       the Firebase value verbatim (staging imports
--                       `snapwear` inactive, D59), and a later deactivation of
--                       the default printer must not be blocked by this row.
--                       Readers treat a default that points at an inactive
--                       printer as "no usable default"; the read route shows
--                       the printer's status beside it.
--
-- The migration seeds the row. Writers UPDATE it (`WHERE id = 1`) or upsert
-- with `ON CONFLICT(id) DO UPDATE`; it can never be deleted.
-- ----------------------------------------------------------------------------
CREATE TABLE print_defaults (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  default_printer_id TEXT REFERENCES printers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  updated_by TEXT CHECK (updated_by IS NULL OR length(updated_by) BETWEEN 1 AND 128)
);

INSERT INTO print_defaults (id, default_printer_id, updated_at, updated_by)
VALUES (1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL);

CREATE TRIGGER print_defaults_no_delete
BEFORE DELETE ON print_defaults
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'print_defaults is a single permanent row');
END;

-- A tenant-owned printer serves one shop only, so it can never be the
-- platform's default.
CREATE TRIGGER print_defaults_platform_printer_insert
BEFORE INSERT ON print_defaults
FOR EACH ROW
WHEN NEW.default_printer_id IS NOT NULL
  AND (SELECT tenant_id FROM printers WHERE id = NEW.default_printer_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'the default printer must be a platform printer');
END;

CREATE TRIGGER print_defaults_platform_printer_update
BEFORE UPDATE OF default_printer_id ON print_defaults
FOR EACH ROW
WHEN NEW.default_printer_id IS NOT NULL
  AND (SELECT tenant_id FROM printers WHERE id = NEW.default_printer_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'the default printer must be a platform printer');
END;


-- ----------------------------------------------------------------------------
-- printer_catalog — the supplier's catalogue document, one row per printer
-- (Firebase `printerCatalog/{printerId}`, manifest row 45).
--
-- PLATFORM-ONLY (A13, "never show our hand"): no tenant route selects from
-- this table. It holds the supplier's own model/SKU sheet and, beside it, the
-- pricing basis (supplier list prices, exchange rate, buffer).
--
--   catalog_json        the document as stored, a JSON object. The platform
--                       route stores JSON.stringify of the parsed body.
--                       CAP 1 MiB (1 048 576 BYTES, checked on the UTF-8
--                       bytes): the SnapWear catalogue is 48 KB as stored
--                       (77 KB pretty-printed on disk) for 47 models / 323
--                       SKUs, so the cap leaves >20× headroom while staying
--                       well inside D1's 2 MB value limit and small enough to
--                       parse whole in one Worker request.
--   source              free text naming where the document came from
--                       (sheet names, generator), optional.
--   pricing_basis_json  the supplier basis the tiers were derived from, a
--                       JSON object (≤ 16 KiB), optional. Carried, never
--                       interpreted by the schema.
--   content_sha256      lowercase hex sha256 of the UTF-8 bytes of
--                       catalog_json EXACTLY as stored. Every writer (route
--                       or importer) computes it over those bytes; the
--                       catalogue apply route fences on it.
--   imported_at / imported_by   when and by whom the row was last written.
-- ----------------------------------------------------------------------------
CREATE TABLE printer_catalog (
  printer_id TEXT PRIMARY KEY NOT NULL REFERENCES printers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  catalog_json TEXT NOT NULL CHECK (
    json_valid(catalog_json)
    AND json_type(catalog_json) = 'object'
    AND length(CAST(catalog_json AS BLOB)) <= 1048576
  ),
  source TEXT CHECK (source IS NULL OR length(source) BETWEEN 1 AND 500),
  pricing_basis_json TEXT CHECK (
    pricing_basis_json IS NULL
    OR (
      json_valid(pricing_basis_json)
      AND json_type(pricing_basis_json) = 'object'
      AND length(CAST(pricing_basis_json AS BLOB)) <= 16384
    )
  ),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  imported_at TEXT NOT NULL CHECK (imported_at IS strftime('%Y-%m-%dT%H:%M:%fZ', imported_at)),
  imported_by TEXT CHECK (imported_by IS NULL OR length(imported_by) BETWEEN 1 AND 128)
);

CREATE TRIGGER printer_catalog_platform_printer
BEFORE INSERT ON printer_catalog
FOR EACH ROW
WHEN (SELECT tenant_id FROM printers WHERE id = NEW.printer_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a printer catalogue belongs to a platform printer');
END;


-- ----------------------------------------------------------------------------
-- printers.revision — the fence for read-modify-write edits.
--
-- PATCH /v1/platform/printers/:id and the catalogue apply read the printer,
-- its tiers and its active mappings, decide the next state and the mappings to
-- suspend, then write in ONE batch. The batch's first statement sets
-- `revision = <revision read> + 1`; this trigger aborts the whole batch when
-- the stored revision is no longer the one that was read (another edit or a
-- replace-all landed in between), so a decision is never written over a state
-- it did not see. Every writer of a printer row or its tiers through the
-- Worker bumps the revision by exactly one (the replace-all PUT included).
-- An UPDATE that does not name `revision` (e.g. an import script) is not
-- fenced and does not move it.
-- ----------------------------------------------------------------------------
ALTER TABLE printers ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);

CREATE TRIGGER printers_revision_step
BEFORE UPDATE OF revision ON printers
FOR EACH ROW
WHEN NEW.revision IS NOT OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'printer revision conflict');
END;


-- ----------------------------------------------------------------------------
-- `default` is never a printer id: /v1/platform/printers/default is the
-- default-printer resource, so a printer with that id could never be
-- addressed. The routes refuse it too; this is the schema's half.
-- ----------------------------------------------------------------------------
CREATE TRIGGER printers_id_not_reserved_insert
BEFORE INSERT ON printers
FOR EACH ROW
WHEN NEW.id = 'default'
BEGIN
  SELECT RAISE(ABORT, 'printer id is reserved');
END;

CREATE TRIGGER printers_id_not_reserved_update
BEFORE UPDATE OF id ON printers
FOR EACH ROW
WHEN NEW.id = 'default'
BEGIN
  SELECT RAISE(ABORT, 'printer id is reserved');
END;
