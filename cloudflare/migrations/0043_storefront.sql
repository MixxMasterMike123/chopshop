PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP4-D — the storefront response, search engines, forwarding (D88, D81).
--
--   redirects            a shop's permanent forwards: an old address of the
--                        shop (relative to its root) → a path of the shop's own
--                        storefront, answered as a 301 by GET /v1/seo. Written
--                        by PUT /v1/admin/redirects and the importer.
--   catalog_version      the bumps the public storefront response needs
--                        (PLAN §2.4): the store identity, the features, the
--                        support address it prints, and the public objects
--                        its images are made from.
--
-- TIME: ISO-8601 UTC TEXT in the exact Date.prototype.toISOString() shape,
-- pinned by the strftime round-trip CHECK every newer table uses.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- redirects — ONE normal form for both paths, made by ONE function at write
-- and at lookup (src/storefront/redirects.ts normalizeStorefrontPath):
-- percent-decoded to UTF-8, NFC per segment, the query and fragment dropped,
-- no trailing slash, no empty, `.` or `..` segment, no backslash, no control
-- character, case kept as given. Old addresses hold percent-encoded emoji, so
-- the decoded form is what is stored and compared.
--
--   from_path   never the root: a forward of the home would make the shop
--               unreachable. The code also refuses the paths the storefront
--               needs to sell (cart, checkout, the order pages, …).
--   to_path     a path relative to the shop's root. It starts with ONE slash,
--               so it can never carry a scheme or name another host; the CHECKs
--               below repeat the rules the code enforces first.
--
-- NO CHAIN, NO LOOP: a to_path is never a from_path of the same shop, and a
-- from_path is never a to_path of the same shop. Enforced by the code (a clear
-- 400) and, as the last fence, by the two triggers below; with both
-- directions refused, a chain of two cannot exist, and so neither can a loop.
-- ----------------------------------------------------------------------------
CREATE TABLE redirects (
  tenant_id TEXT NOT NULL
    REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  from_path TEXT NOT NULL CHECK (
    length(from_path) BETWEEN 2 AND 2048
    AND substr(from_path, 1, 1) = '/'
    AND substr(from_path, -1, 1) <> '/'
    AND instr(from_path, '//') = 0
    AND instr(from_path, '\') = 0
    AND instr(from_path || '/', '/./') = 0
    AND instr(from_path || '/', '/../') = 0
  ),
  to_path TEXT NOT NULL CHECK (
    length(to_path) BETWEEN 1 AND 2048
    AND substr(to_path, 1, 1) = '/'
    AND (to_path = '/' OR substr(to_path, -1, 1) <> '/')
    AND instr(to_path, '//') = 0
    AND instr(to_path, '\') = 0
    AND instr(to_path || '/', '/./') = 0
    AND instr(to_path || '/', '/../') = 0
  ),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 128),
  PRIMARY KEY (tenant_id, from_path),
  CHECK (from_path <> to_path)
);

CREATE INDEX redirects_tenant_to_path_idx ON redirects(tenant_id, to_path);

CREATE TRIGGER redirects_tenant_immutable
BEFORE UPDATE OF tenant_id ON redirects
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- An UPSERT (INSERT … ON CONFLICT DO UPDATE) runs this trigger first and the
-- update trigger below on a conflict. Neither condition can match the row's
-- own old values: from_path <> to_path holds for every row.
CREATE TRIGGER redirects_no_chain_insert
BEFORE INSERT ON redirects
FOR EACH ROW
WHEN EXISTS (
       SELECT 1 FROM redirects AS other
       WHERE other.tenant_id = NEW.tenant_id AND other.from_path = NEW.to_path
     )
  OR EXISTS (
       SELECT 1 FROM redirects AS other
       WHERE other.tenant_id = NEW.tenant_id AND other.to_path = NEW.from_path
     )
BEGIN
  SELECT RAISE(ABORT, 'a forward must not chain');
END;

CREATE TRIGGER redirects_no_chain_update
BEFORE UPDATE OF from_path, to_path ON redirects
FOR EACH ROW
WHEN EXISTS (
       SELECT 1 FROM redirects AS other
       WHERE other.tenant_id = NEW.tenant_id
         AND other.from_path = NEW.to_path
         AND other.from_path <> OLD.from_path
     )
  OR EXISTS (
       SELECT 1 FROM redirects AS other
       WHERE other.tenant_id = NEW.tenant_id
         AND other.to_path = NEW.from_path
         AND other.from_path <> OLD.from_path
     )
BEGIN
  SELECT RAISE(ABORT, 'a forward must not chain');
END;


-- ---- catalog_version bump triggers (PLAN §2.4, brief rule 6) ---------------
--
-- Deliberately broad, as 0025's: over-bumping costs one cache miss, a missed
-- bump serves a stale 304. Each inner UPDATE names only catalog_version, so it
-- re-fires none of these triggers nor 0025's `UPDATE OF status, …` trigger.

-- The store identity: the allowlisted keys, branding, menu, pickup places,
-- theme and template of GET /v1/storefront are built from it.
CREATE TRIGGER catalog_version_tenant_settings_insert
AFTER INSERT ON tenant_settings
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_tenant_settings_update
AFTER UPDATE ON tenant_settings
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_tenant_settings_delete
AFTER DELETE ON tenant_settings
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = OLD.tenant_id;
END;

-- The features: `features` of GET /v1/storefront.
CREATE TRIGGER catalog_version_tenant_features_insert
AFTER INSERT ON tenant_features
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_tenant_features_update
AFTER UPDATE ON tenant_features
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_tenant_features_delete
AFTER DELETE ON tenant_features
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = OLD.tenant_id;
END;

-- The shop's support address: the footer prints it and the home's JSON-LD
-- names it, so GET /v1/storefront carries it (identity.supportEmail). 0025's
-- trigger on `tenants` lists the other public columns, not this one.
CREATE TRIGGER catalog_version_tenants_support_email
AFTER UPDATE OF support_email ON tenants
FOR EACH ROW
WHEN OLD.support_email IS NOT NEW.support_email
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

-- Public objects: every image of a public shape is resolved at read time from
-- its row (src/storage/public-objects.ts), so a row that becomes or stops
-- being active changes a public body without touching the row that names it
-- (D93: a removed object leaves the reference in place).
CREATE TRIGGER catalog_version_public_objects_insert
AFTER INSERT ON stored_objects
FOR EACH ROW
WHEN NEW.bucket = 'public' AND NEW.status = 'active'
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_public_objects_update
AFTER UPDATE OF status, bucket, object_key ON stored_objects
FOR EACH ROW
WHEN OLD.bucket = 'public' OR NEW.bucket = 'public'
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

-- Forwards: no cached read is built from them today (GET /v1/seo answers
-- no-store), but a forward is what a visitor sees, and the rule is that
-- everything a visitor sees moves the version.
CREATE TRIGGER catalog_version_redirects_insert
AFTER INSERT ON redirects
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_redirects_update
AFTER UPDATE ON redirects
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_redirects_delete
AFTER DELETE ON redirects
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = OLD.tenant_id;
END;
