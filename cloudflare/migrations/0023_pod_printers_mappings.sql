PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP2-C — the POD product path: printers, their price tiers, product→artwork
-- mappings, and the production snapshot a checkout freezes.
--
-- SSOT for the rules: docs/cf-port/PLAN.md §2.3 ("Production eligibility at
-- checkout"), §2.4; docs/SnapWearDocs/LAUNCH_TODO.md A1 (withholding), A2–A4
-- (per-printer print areas, capability gating), A13 (seller sees ONE number).
-- Ported from functions/src/print/printRouting.ts + printProjection.ts.
--
-- TIME: every new TEXT timestamp is ISO-8601 UTC in the exact
-- Date.prototype.toISOString() shape, pinned by the strftime round-trip CHECK
-- 0013/0014/0017 use, so lexicographic order stays chronological.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- printers — who prints. PLATFORM-owned rows carry tenant_id NULL (every row
-- today: `fake-printer` in staging, `snapwear` in production, seeded by the
-- platform route PUT /v1/platform/printers). A tenant-owned printer is modelled
-- (tenant_id set) but no route creates one yet.
--
-- COST COLUMNS ARE PLATFORM-ONLY (A13). `shipping_cost_minor` is the printer's
-- flat per-order parcel price (ex VAT, withheld once per printer per order —
-- Firebase `printers/{uid}.shippingSek`). No tenant-facing route selects it.
--
-- capabilities_json is the printer's physical capability (A2/A3):
--   { "models": { "<model>": { "garment": "tee"|null, "name"?: "…",
--                              "printAreasMm": { "front": {"w":…,"h":…,"offsetTopMm"?:…}, … } } },
--     "skus":   { "<printer sku>": { "model": "<model>", "label"?: "…" } } }
-- An ABSENT slot frame = the printer cannot print that slot (fail closed; the
-- Firebase "no frames = ungated" lenience is NOT carried).
-- ----------------------------------------------------------------------------
CREATE TABLE printers (
  id TEXT PRIMARY KEY NOT NULL CHECK (
    length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^a-z0-9-]*'
  ),
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('api', 'manual')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  shipping_cost_minor INTEGER NOT NULL DEFAULT 0 CHECK (
    shipping_cost_minor >= 0 AND shipping_cost_minor <= 10000000
  ),
  capabilities_json TEXT NOT NULL CHECK (
    json_valid(capabilities_json) AND json_type(capabilities_json) = 'object'
  ),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK (updated_at >= created_at)
);

CREATE TRIGGER printers_tenant_immutable
BEFORE UPDATE OF tenant_id ON printers
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE INDEX printers_tenant_status_idx ON printers(tenant_id, status);


-- ----------------------------------------------------------------------------
-- printer_sku_tiers — what a printer charges, per printer SKU. PLATFORM-ONLY
-- READABLE (A13): nothing tenant-facing selects from this table; the seller
-- receives one finished number (quotePodCost → `inkopMinor`).
--
--   blank_cost_minor   the blank garment, ex VAT (Firebase blankCostSek[garment])
--   print_costs_json   { "<slot>": <minor>, … } ex VAT (Firebase printCostSek[slot])
--
-- tenant_id mirrors the printer's (NULL for platform printers) so the table has
-- the same tenancy shape as everything else; a trigger pins the mirror.
-- ----------------------------------------------------------------------------
CREATE TABLE printer_sku_tiers (
  printer_id TEXT NOT NULL REFERENCES printers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sku TEXT NOT NULL CHECK (length(sku) BETWEEN 1 AND 64),
  blank_cost_minor INTEGER NOT NULL CHECK (blank_cost_minor >= 0 AND blank_cost_minor <= 10000000),
  print_costs_json TEXT NOT NULL CHECK (
    json_valid(print_costs_json) AND json_type(print_costs_json) = 'object'
  ),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK (updated_at >= created_at),
  PRIMARY KEY (printer_id, sku)
);

CREATE TRIGGER printer_sku_tiers_tenant_immutable
BEFORE UPDATE OF tenant_id ON printer_sku_tiers
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER printer_sku_tiers_tenant_matches_printer
BEFORE INSERT ON printer_sku_tiers
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (SELECT tenant_id FROM printers WHERE id = NEW.printer_id)
BEGIN
  SELECT RAISE(ABORT, 'tier tenant_id must match printer tenant_id');
END;

CREATE INDEX printer_sku_tiers_tenant_printer_idx ON printer_sku_tiers(tenant_id, printer_id);


-- ----------------------------------------------------------------------------
-- pod_mappings — "this product prints this artwork on these slots of this
-- printer SKU". The CF equivalent of Firebase `podMappings`, keyed by the
-- product FK instead of the product SKU (Firebase had no product id on the row).
--
--   variant_id   NULL = the product-level mapping set; set = a variant's own set
--                (per-size/colour printer SKU). A checkout line uses its
--                variant's set when one exists, else the product-level set.
--   sku          the PRINTER's SKU (SnapWear's number), frozen onto the snapshot.
--   slots_json   [{ "slot": "front", "widthMm": …, "heightMm": … }] — the print
--                areas this artwork fills, sized server-side at creation (contain
--                fit inside the printer's frame, capped at the artwork's min DPI).
--   status       active | inactive (seller deleted — rows are never hard-deleted:
--                they keep the artwork, and so the print master, referenced) |
--                suspended (the printer lost the capability or the price —
--                routing edit, PUT /v1/platform/printers).
-- ----------------------------------------------------------------------------
CREATE TABLE pod_mappings (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  variant_id TEXT REFERENCES product_variants(variant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  artwork_id TEXT NOT NULL REFERENCES pod_artwork(artwork_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  printer_id TEXT NOT NULL REFERENCES printers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sku TEXT NOT NULL CHECK (length(sku) BETWEEN 1 AND 64),
  slots_json TEXT NOT NULL CHECK (
    json_valid(slots_json)
    AND json_type(slots_json) = 'array'
    AND json_array_length(slots_json) BETWEEN 1 AND 6
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'suspended')),
  suspended_reason TEXT CHECK (
    suspended_reason IS NULL
    OR suspended_reason IN ('sku_unavailable', 'slot_not_printable', 'unpriced')
  ),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'suspended') = (suspended_reason IS NOT NULL)),
  UNIQUE (product_id, artwork_id, printer_id, sku)
);

CREATE TRIGGER pod_mappings_tenant_immutable
BEFORE UPDATE OF tenant_id ON pod_mappings
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- What a mapping IS never changes; a different product/artwork/printer/SKU is a
-- different row. Only status, suspended_reason, slots_json and updated_at move.
CREATE TRIGGER pod_mappings_identity_immutable
BEFORE UPDATE ON pod_mappings
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.product_id IS NOT OLD.product_id
  OR NEW.variant_id IS NOT OLD.variant_id
  OR NEW.artwork_id IS NOT OLD.artwork_id
  OR NEW.printer_id IS NOT OLD.printer_id
  OR NEW.sku IS NOT OLD.sku
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'pod mapping identity is immutable');
END;

-- The FKs reference GLOBAL primary keys, so each is satisfied by ANY tenant's
-- row; these close that gap (the same discipline 0007/0012 apply).
CREATE TRIGGER pod_mappings_product_tenant_matches
BEFORE INSERT ON pod_mappings
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (SELECT tenant_id FROM products WHERE product_id = NEW.product_id)
BEGIN
  SELECT RAISE(ABORT, 'mapping product must belong to the same tenant');
END;

CREATE TRIGGER pod_mappings_artwork_tenant_matches
BEFORE INSERT ON pod_mappings
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (SELECT tenant_id FROM pod_artwork WHERE artwork_id = NEW.artwork_id)
BEGIN
  SELECT RAISE(ABORT, 'mapping artwork must belong to the same tenant');
END;

CREATE TRIGGER pod_mappings_variant_matches_product
BEFORE INSERT ON pod_mappings
FOR EACH ROW
WHEN NEW.variant_id IS NOT NULL
  AND NEW.product_id IS NOT (SELECT product_id FROM product_variants WHERE variant_id = NEW.variant_id)
BEGIN
  SELECT RAISE(ABORT, 'mapping variant must belong to the mapped product');
END;

-- A platform printer (tenant_id NULL) serves every tenant; a tenant printer
-- serves only its own tenant.
CREATE TRIGGER pod_mappings_printer_tenant_allowed
BEFORE INSERT ON pod_mappings
FOR EACH ROW
WHEN (SELECT tenant_id FROM printers WHERE id = NEW.printer_id) IS NOT NULL
  AND (SELECT tenant_id FROM printers WHERE id = NEW.printer_id) IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'mapping printer must be a platform printer or the tenant''s own');
END;

CREATE INDEX pod_mappings_tenant_product_status_idx
  ON pod_mappings(tenant_id, product_id, status);
CREATE INDEX pod_mappings_tenant_artwork_idx ON pod_mappings(tenant_id, artwork_id);
-- Routing edits revalidate every mapping on one printer (a platform operation
-- across tenants), so this one is printer-first by design.
CREATE INDEX pod_mappings_printer_status_idx ON pod_mappings(printer_id, status);


-- ----------------------------------------------------------------------------
-- checkouts.production_snapshot_json — FROZEN at checkout creation for a cart
-- that contains POD products (NULL otherwise). The shared contract CP2-A copies
-- onto the order and CP2-B dispatches from:
--
--   { "printer": "fake-printer"|"snapwear",
--     "lines": [{ "lineNo": item_index+1, "sku": "<printer sku>", "quantity": n,
--                 "printFiles": [{ "slot", "r2Key", "sha256", "widthMm", "heightMm" }],
--                 "productionCostMinor": …, "withholdMinor": … }],
--     "totals": { "productionCostMinor": …, "withholdMinor": … } }
--
-- SERVER-ONLY: no response ever carries it. Set once by the INSERT; afterwards
-- it may only be PURGED to NULL (the retention sweep, PLAN §2.3), never
-- rewritten or filled in later.
-- ----------------------------------------------------------------------------
ALTER TABLE checkouts ADD COLUMN production_snapshot_json TEXT CHECK (
  production_snapshot_json IS NULL
  OR (
    json_valid(production_snapshot_json)
    AND json_type(production_snapshot_json) = 'object'
  )
);

CREATE TRIGGER checkouts_production_snapshot_frozen
BEFORE UPDATE OF production_snapshot_json ON checkouts
FOR EACH ROW
WHEN NEW.production_snapshot_json IS NOT NULL
  AND NEW.production_snapshot_json IS NOT OLD.production_snapshot_json
BEGIN
  SELECT RAISE(ABORT, 'production snapshot is frozen; it may only be purged');
END;
