PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP4-C — content pages and posts (manifest row 40, D84, D88, D94).
--
-- Firebase source: the `pages` collection (writer src/pages/admin/
-- AdminPageEdit.jsx; readers DynamicPage.jsx, DynamicRouteHandler.jsx,
-- ShopFooter.jsx). A post is a kind of page (D88): the same row with a date,
-- an author, a summary and an image, listed newest first. Attachments are not
-- carried (D94). The four legal pages are NOT rows here (D79): a visitor sees
-- the snapshot the seller adopted (0037 legal_acceptances), through a route of
-- its own (src/routes/public-legal.ts).
--
-- Writers: /v1/admin/pages (src/routes/admin-pages.ts) and the CP4 importer.
-- Readers: /v1/pages (src/routes/public-pages.ts) and builder D's storefront
-- menu, search-engine and sitemap reads. THE TABLE AND COLUMN NAMES ARE FIXED
-- by CP4_BRIEFS.md §C: D reads them.
--
-- TEXT PER LANGUAGE (D84): every *_json column is a JSON object keyed by
-- language tag (`sv-SE`), every value a string (trigger below). The tag is
-- two or three lower-case letters, optionally a hyphen and two upper-case
-- letters. `content_json` is the page's HTML (refused at write when it holds
-- anything that can run or fetch: src/content/html-refusal.ts), at most
-- 262 144 BYTES of JSON, counted as UTF-8 by the CAST.
--
-- IMAGES: `image_object_id` names a PUBLIC object of kind `product_media`
-- (0006 stored_objects) of the SAME tenant. The row holds the object id, never
-- an address: the address is made at read time (src/storage/
-- public-objects.ts). A removed image stays named here and simply resolves to
-- nothing (D93).
--
-- TIME: ISO-8601 UTC TEXT in the exact Date.prototype.toISOString() shape,
-- pinned by the strftime round-trip CHECK of 0032. ACTORS: `created_by` and
-- `updated_by` are the writing user's id, NULL for an imported row whose user
-- is not carried; bounded like tenant_settings.updated_by.
--
-- Whatever a visitor can see bumps tenants.catalog_version by trigger (PLAN
-- §2.4, 0025): every write of `pages` and a new legal-pages adoption here; a
-- change of an object a page names as its image through 0043.
-- ============================================================================

CREATE TABLE pages (
  page_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(page_id) BETWEEN 1 AND 128 AND page_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- One path segment of the storefront (`<root>/<slug>`): lower-case ASCII
  -- letters, digits and inner hyphens. The first segments the storefront owns
  -- are refused by the triggers below.
  slug TEXT NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 100
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT GLOB '-*'
    AND slug NOT GLOB '*-'
  ),
  kind TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'post')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  title_json TEXT NOT NULL CHECK (
    json_valid(title_json)
    AND json_type(title_json) = 'object'
    AND length(CAST(title_json AS BLOB)) <= 16384
  ),
  content_json TEXT NOT NULL CHECK (
    json_valid(content_json)
    AND json_type(content_json) = 'object'
    AND length(CAST(content_json AS BLOB)) <= 262144
  ),
  summary_json TEXT CHECK (
    summary_json IS NULL
    OR (
      json_valid(summary_json)
      AND json_type(summary_json) = 'object'
      AND length(CAST(summary_json AS BLOB)) <= 65536
    )
  ),
  meta_title_json TEXT CHECK (
    meta_title_json IS NULL
    OR (
      json_valid(meta_title_json)
      AND json_type(meta_title_json) = 'object'
      AND length(CAST(meta_title_json AS BLOB)) <= 16384
    )
  ),
  meta_description_json TEXT CHECK (
    meta_description_json IS NULL
    OR (
      json_valid(meta_description_json)
      AND json_type(meta_description_json) = 'object'
      AND length(CAST(meta_description_json AS BLOB)) <= 32768
    )
  ),
  author TEXT CHECK (author IS NULL OR length(author) BETWEEN 1 AND 200),
  image_object_id TEXT
    REFERENCES stored_objects(object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Set the first time the page is published and kept when it goes back to
  -- draft, so a re-publish keeps its date; an admin or the importer may set it.
  published_at TEXT CHECK (
    published_at IS NULL OR published_at IS strftime('%Y-%m-%dT%H:%M:%fZ', published_at)
  ),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND updated_at >= created_at
  ),
  created_by TEXT CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 128),
  updated_by TEXT CHECK (updated_by IS NULL OR length(updated_by) BETWEEN 1 AND 128),
  -- A published page always has its date (the posts list orders on it).
  CHECK (status <> 'published' OR published_at IS NOT NULL),
  UNIQUE (tenant_id, slug)
);

-- The published list, newest first, keyset on (published_at, page_id).
CREATE INDEX pages_public_idx ON pages(tenant_id, status, published_at DESC, page_id DESC);
-- The admin list, newest first, keyset on (created_at, page_id).
CREATE INDEX pages_admin_idx ON pages(tenant_id, created_at DESC, page_id DESC);

CREATE TRIGGER pages_tenant_immutable
BEFORE UPDATE OF tenant_id ON pages
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER pages_id_immutable
BEFORE UPDATE OF page_id ON pages
FOR EACH ROW
WHEN OLD.page_id IS NOT NEW.page_id
BEGIN
  SELECT RAISE(ABORT, 'page_id is immutable');
END;

-- ── the storefront's own first segments (CP4_BRIEFS.md "The address grammar")
-- plus `legal` (the legal pages live at <root>/legal/<…>) and the four legal
-- keys. MUST equal RESERVED_PAGE_SLUGS in src/content/pages.ts
-- (test/pages.test.ts pins the two together). A trigger, not a CHECK, so a
-- later migration can change the list without rebuilding the table.
CREATE TRIGGER pages_reserved_slug_insert
BEFORE INSERT ON pages
FOR EACH ROW
WHEN NEW.slug IN (
  '_api', 'angerratt', 'angra', 'assets', 'cart', 'checkout', 'integritetspolicy',
  'kategori', 'kopvillkor', 'legal', 'order-confirmation', 'order-return',
  'plattformsvillkor', 'product', 'produkter', 'rapportera-intrang', 'samling', 'tagg'
)
BEGIN
  SELECT RAISE(ABORT, 'the slug is reserved by the storefront');
END;

CREATE TRIGGER pages_reserved_slug_update
BEFORE UPDATE OF slug ON pages
FOR EACH ROW
WHEN NEW.slug IN (
  '_api', 'angerratt', 'angra', 'assets', 'cart', 'checkout', 'integritetspolicy',
  'kategori', 'kopvillkor', 'legal', 'order-confirmation', 'order-return',
  'plattformsvillkor', 'product', 'produkter', 'rapportera-intrang', 'samling', 'tagg'
)
BEGIN
  SELECT RAISE(ABORT, 'the slug is reserved by the storefront');
END;

-- ── every text is a map of language tag → string; title and content name at
-- least one language. SQLite forbids the subquery this needs inside a CHECK.
CREATE TRIGGER pages_language_maps_insert
BEFORE INSERT ON pages
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM json_each(NEW.title_json))
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.content_json))
  OR EXISTS (
    SELECT 1 FROM (
      SELECT key, type FROM json_each(NEW.title_json)
      UNION ALL SELECT key, type FROM json_each(NEW.content_json)
      UNION ALL SELECT key, type FROM json_each(COALESCE(NEW.summary_json, '{}'))
      UNION ALL SELECT key, type FROM json_each(COALESCE(NEW.meta_title_json, '{}'))
      UNION ALL SELECT key, type FROM json_each(COALESCE(NEW.meta_description_json, '{}'))
    )
    WHERE type <> 'text'
      OR NOT (
        key GLOB '[a-z][a-z]'
        OR key GLOB '[a-z][a-z][a-z]'
        OR key GLOB '[a-z][a-z]-[A-Z][A-Z]'
        OR key GLOB '[a-z][a-z][a-z]-[A-Z][A-Z]'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'a page text is a map of language tag to string');
END;

CREATE TRIGGER pages_language_maps_update
BEFORE UPDATE OF title_json, content_json, summary_json, meta_title_json, meta_description_json ON pages
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM json_each(NEW.title_json))
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.content_json))
  OR EXISTS (
    SELECT 1 FROM (
      SELECT key, type FROM json_each(NEW.title_json)
      UNION ALL SELECT key, type FROM json_each(NEW.content_json)
      UNION ALL SELECT key, type FROM json_each(COALESCE(NEW.summary_json, '{}'))
      UNION ALL SELECT key, type FROM json_each(COALESCE(NEW.meta_title_json, '{}'))
      UNION ALL SELECT key, type FROM json_each(COALESCE(NEW.meta_description_json, '{}'))
    )
    WHERE type <> 'text'
      OR NOT (
        key GLOB '[a-z][a-z]'
        OR key GLOB '[a-z][a-z][a-z]'
        OR key GLOB '[a-z][a-z]-[A-Z][A-Z]'
        OR key GLOB '[a-z][a-z][a-z]-[A-Z][A-Z]'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'a page text is a map of language tag to string');
END;

-- ── the image is a public product image of the SAME tenant (the tenant-match
-- rule of 0005). Whether it is still active is asked at read time.
CREATE TRIGGER pages_image_tenant_matches_insert
BEFORE INSERT ON pages
FOR EACH ROW
WHEN NEW.image_object_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM stored_objects
    WHERE object_id = NEW.image_object_id
      AND tenant_id = NEW.tenant_id
      AND bucket = 'public'
      AND kind = 'product_media'
  )
BEGIN
  SELECT RAISE(ABORT, 'page image must be a public product image of the page tenant');
END;

CREATE TRIGGER pages_image_tenant_matches_update
BEFORE UPDATE OF image_object_id, tenant_id ON pages
FOR EACH ROW
WHEN NEW.image_object_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM stored_objects
    WHERE object_id = NEW.image_object_id
      AND tenant_id = NEW.tenant_id
      AND bucket = 'public'
      AND kind = 'product_media'
  )
BEGIN
  SELECT RAISE(ABORT, 'page image must be a public product image of the page tenant');
END;

-- ── catalog_version (PLAN §2.4, 0025). Over-bumping costs a cache miss (a
-- draft edit bumps too); under-bumping would serve a stale 304.

CREATE TRIGGER catalog_version_pages_insert
AFTER INSERT ON pages
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_pages_update
AFTER UPDATE ON pages
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_pages_delete
AFTER DELETE ON pages
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = OLD.tenant_id;
END;

-- A new legal-pages adoption (Worker or import) changes what GET /v1/legal and
-- GET /v1/legal/:key answer. 0037's table is append-only, so INSERT is the
-- only event.
CREATE TRIGGER catalog_version_legal_acceptances_insert
AFTER INSERT ON legal_acceptances
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

-- A change of an object a page names as its image (a removal, D93) bumps the
-- version through 0043's triggers on public objects, which cover every public
-- object of the shop.
