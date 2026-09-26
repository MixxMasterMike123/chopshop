PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP2-C — takedown protection and the per-tenant catalog_version (PLAN §2.4).
--
-- products.takedown_at: a platform takedown stamp (POST /v1/platform/screening/
-- :productId {"decision":"blocked"}). A taken-down product is never public (the
-- eligibility predicate, src/catalog/eligibility.ts) and cannot be deleted —
-- platform deletion must clear the stamp first through an audited force path
-- (not built: no product deletion route exists yet).
--
-- tenants.catalog_version: every public read (product list, product detail,
-- storefront; later collections/menu/sitemap/JSON-LD) answers
-- `ETag: "<catalog_version>"`. It is bumped by TRIGGER, inside the very
-- statement that changes anything a public response is built from — so the bump
-- is in the same transaction as the eligibility transition by construction, no
-- matter which code path (publish, unpublish, deactivate, takedown, screening
-- decision, mapping, shop status) wrote it. Over-bumping (e.g. a draft edit) only
-- costs a cache miss; under-bumping would serve a stale 304, so the triggers are
-- deliberately broad.
--
-- tenants.published: the shop go-live gate (Firebase `shops/{id}.published`,
-- block only on === false) that §2.4's predicate names. Default 1; the writer is
-- CP3's live-gate route.
-- ============================================================================

ALTER TABLE products ADD COLUMN takedown_at TEXT CHECK (
  takedown_at IS NULL
  OR takedown_at IS strftime('%Y-%m-%dT%H:%M:%fZ', takedown_at)
);

CREATE TRIGGER products_takedown_no_delete
BEFORE DELETE ON products
FOR EACH ROW
WHEN OLD.takedown_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a taken-down product cannot be deleted');
END;

ALTER TABLE tenants ADD COLUMN catalog_version INTEGER NOT NULL DEFAULT 1
  CHECK (catalog_version >= 1);

ALTER TABLE tenants ADD COLUMN published INTEGER NOT NULL DEFAULT 1
  CHECK (published IN (0, 1));

-- ---- catalog_version bump triggers ----------------------------------------

CREATE TRIGGER catalog_version_products_update
AFTER UPDATE ON products
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_publications_insert
AFTER INSERT ON product_publications
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_publications_update
AFTER UPDATE ON product_publications
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_publications_delete
AFTER DELETE ON product_publications
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = OLD.tenant_id;
END;

CREATE TRIGGER catalog_version_variants_insert
AFTER INSERT ON product_variants
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_variants_update
AFTER UPDATE ON product_variants
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_variants_delete
AFTER DELETE ON product_variants
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = OLD.tenant_id;
END;

CREATE TRIGGER catalog_version_mappings_insert
AFTER INSERT ON pod_mappings
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_mappings_update
AFTER UPDATE ON pod_mappings
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_screening_insert
AFTER INSERT ON product_screening
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_screening_update
AFTER UPDATE ON product_screening
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

-- A platform printer serves many tenants: a status/capability change bumps
-- every tenant that maps to it (public POD eligibility requires an ACTIVE
-- printer behind an active mapping).
CREATE TRIGGER catalog_version_printers_update
AFTER UPDATE ON printers
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1
  WHERE tenant_id IN (SELECT DISTINCT tenant_id FROM pod_mappings WHERE printer_id = NEW.id);
END;

-- Shop status / go-live gate / the storefront's own public fields. The inner
-- UPDATE names only catalog_version, so it does not re-fire this trigger.
CREATE TRIGGER catalog_version_tenants_update
AFTER UPDATE OF status, published, shop_name, default_locale, default_currency ON tenants
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;
