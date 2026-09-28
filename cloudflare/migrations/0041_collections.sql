PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP4-B — collections (manifest row 20, D87).
--
-- Firebase source: the `collections` collection, written by
-- AdminCollectionEdit.jsx and AdminCollections.jsx (title, handle,
-- description, imageUrl, type, productIds[], rule.tag, published, featured,
-- sortOrder) and read by PublicStorefront.jsx (the featured cards),
-- ProductCollectionPage.jsx (`/samling/<handle>`) and AdminMenu.jsx.
--
--   collections           one row per collection. MANUAL: hand-picked
--                         products in the admin's order (collection_products).
--                         SMART: every public product carrying `rule_tag`,
--                         matched by the tag's ADDRESS form (slugify, as
--                         product_tags.tag_key and the /tagg/<key> page do),
--                         in the storefront's display order.
--   collection_products   the members of a manual collection, in order.
--
-- Writers: /v1/admin/collections (src/routes/admin-collections.ts) and the
-- CP4 importer. Readers: /v1/collections (src/routes/public-collections.ts)
-- and builder D's menu, search-engine and sitemap reads. THE TABLE AND COLUMN
-- NAMES ARE FIXED by CP4_BRIEFS.md §B: D reads them.
--
-- A collection's PRODUCTS reach a visitor only through builder A's public
-- functions (src/catalog/public-catalog.ts listPublicProductsByIds /
-- listPublicProductPage), i.e. through THE predicate: a member that is a
-- draft, archived, taken down or not public for any other reason is simply
-- absent from the answer; its row here stays.
--
-- ONE NAMESPACE PER SHOP for what `GET /v1/collections/:ref` accepts: a
-- handle, an external_ref and a collection id each name at most one
-- collection, and none of them may equal another collection's handle,
-- external_ref or id in the same shop. Enforced by the code first (a clear
-- 409) and, as the last fence, by the unique constraints and the triggers
-- below, in both directions.
--
-- The cover (`image_object_id`) names a PUBLIC object of kind `product_media`
-- of the same shop, active when it is written. The row holds the object id,
-- never an address (src/storage/public-objects.ts). A removed image stays
-- named here and resolves to nothing (D93).
--
-- TIME: ISO-8601 UTC TEXT in the exact Date.prototype.toISOString() shape,
-- pinned by the strftime round-trip CHECK of the newer tables (0032, 0042).
--
-- Whatever a visitor can see bumps tenants.catalog_version (PLAN §2.4): every
-- insert, update and delete of both tables, by trigger. A change of the cover
-- object itself is covered by 0043's triggers on public objects.
-- ============================================================================

CREATE TABLE collections (
  collection_id TEXT PRIMARY KEY NOT NULL CHECK (
    length(collection_id) BETWEEN 1 AND 128
    AND collection_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- One storefront path segment (`<root>/samling/<handle>`), as the source's
  -- slugify leaves it: lower-case ASCII letters, digits, `_` and `-`, never
  -- two hyphens in a row, at least one letter or digit. Exactly the fixed
  -- points of slugify (src/catalog/collections.ts isCollectionHandle).
  handle TEXT NOT NULL CHECK (
    length(handle) BETWEEN 1 AND 200
    AND handle NOT GLOB '*[^a-z0-9_-]*'
    AND handle NOT GLOB '*[-][-]*'
    AND handle GLOB '*[a-z0-9]*'
  ),
  -- The id the collection had in the system it came from (D87), so a shop's
  -- own site keeps asking by it. URL-unreserved characters only, so it is
  -- one path segment that never needs an escape; at least one letter or
  -- digit, so it is never a dot segment.
  external_ref TEXT CHECK (
    external_ref IS NULL
    OR (
      length(external_ref) BETWEEN 1 AND 128
      AND external_ref NOT GLOB '*[^A-Za-z0-9._~-]*'
      AND external_ref GLOB '*[A-Za-z0-9]*'
    )
  ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 5000),
  image_object_id TEXT
    REFERENCES stored_objects(object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('manual', 'smart')),
  -- The tag as the seller chose it (product_tags.tag's rule: 1–50 characters).
  rule_tag TEXT CHECK (rule_tag IS NULL OR length(rule_tag) BETWEEN 1 AND 50),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  -- The home's "Populära samlingar" cards.
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  -- The admin's drag order; NULL = none (sorts last, then by title).
  sort_order INTEGER CHECK (
    sort_order IS NULL OR sort_order BETWEEN -1000000000 AND 1000000000
  ),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (
    updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) AND updated_at >= created_at
  ),
  -- The writing user's id; NULL for an imported row whose user is not carried.
  created_by TEXT CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 128),
  updated_by TEXT CHECK (updated_by IS NULL OR length(updated_by) BETWEEN 1 AND 128),
  -- A smart collection has its tag; a manual one has none.
  CHECK (
    (type = 'manual' AND rule_tag IS NULL)
    OR (type = 'smart' AND rule_tag IS NOT NULL)
  ),
  UNIQUE (tenant_id, handle)
);

CREATE UNIQUE INDEX collections_tenant_external_ref_idx
  ON collections(tenant_id, external_ref)
  WHERE external_ref IS NOT NULL;
CREATE INDEX collections_tenant_published_idx ON collections(tenant_id, published);

CREATE TRIGGER collections_tenant_immutable
BEFORE UPDATE OF tenant_id ON collections
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER collections_id_immutable
BEFORE UPDATE OF collection_id ON collections
FOR EACH ROW
WHEN OLD.collection_id IS NOT NEW.collection_id
BEGIN
  SELECT RAISE(ABORT, 'collection_id is immutable');
END;

-- ── the namespace of `:ref` (handle, external_ref, id), per shop ───────────
-- handle = handle and external_ref = external_ref are the unique constraint
-- and the unique index above; these triggers refuse the crossings. An UPSERT
-- runs the insert trigger first and the update triggers on a conflict; none
-- of them compares a row with itself.

CREATE TRIGGER collections_handle_namespace_insert
BEFORE INSERT ON collections
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM collections AS other
  WHERE other.tenant_id = NEW.tenant_id
    AND other.collection_id IS NOT NEW.collection_id
    AND (other.external_ref = NEW.handle OR other.collection_id = NEW.handle)
)
BEGIN
  SELECT RAISE(ABORT, 'the handle names another collection of this shop');
END;

CREATE TRIGGER collections_handle_namespace_update
BEFORE UPDATE OF handle ON collections
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM collections AS other
  WHERE other.tenant_id = NEW.tenant_id
    AND other.collection_id IS NOT NEW.collection_id
    AND (other.external_ref = NEW.handle OR other.collection_id = NEW.handle)
)
BEGIN
  SELECT RAISE(ABORT, 'the handle names another collection of this shop');
END;

CREATE TRIGGER collections_external_ref_namespace_insert
BEFORE INSERT ON collections
FOR EACH ROW
WHEN NEW.external_ref IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM collections AS other
    WHERE other.tenant_id = NEW.tenant_id
      AND other.collection_id IS NOT NEW.collection_id
      AND (other.handle = NEW.external_ref OR other.collection_id = NEW.external_ref)
  )
BEGIN
  SELECT RAISE(ABORT, 'the external reference names another collection of this shop');
END;

CREATE TRIGGER collections_external_ref_namespace_update
BEFORE UPDATE OF external_ref ON collections
FOR EACH ROW
WHEN NEW.external_ref IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM collections AS other
    WHERE other.tenant_id = NEW.tenant_id
      AND other.collection_id IS NOT NEW.collection_id
      AND (other.handle = NEW.external_ref OR other.collection_id = NEW.external_ref)
  )
BEGIN
  SELECT RAISE(ABORT, 'the external reference names another collection of this shop');
END;

-- The id cannot change (collections_id_immutable), so an insert is its only
-- event: a new id (a UUID, or an imported one) that equals another
-- collection's handle or external_ref of the shop is refused.
CREATE TRIGGER collections_id_namespace_insert
BEFORE INSERT ON collections
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM collections AS other
  WHERE other.tenant_id = NEW.tenant_id
    AND other.collection_id IS NOT NEW.collection_id
    AND (other.handle = NEW.collection_id OR other.external_ref = NEW.collection_id)
)
BEGIN
  SELECT RAISE(ABORT, 'the collection id names another collection of this shop');
END;

-- ── the cover: this shop's active public product media (the rule of 0040's
-- product_images). On an update only when the named object CHANGES, so a
-- write of other fields is never refused because the cover was removed since
-- (D93); whether it is still active is asked again at read time.
CREATE TRIGGER collections_image_admitted_insert
BEFORE INSERT ON collections
FOR EACH ROW
WHEN NEW.image_object_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM stored_objects AS object
    WHERE object.object_id = NEW.image_object_id
      AND object.tenant_id = NEW.tenant_id
      AND object.bucket = 'public'
      AND object.kind = 'product_media'
      AND object.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'collection image must be this tenant''s active public product media');
END;

CREATE TRIGGER collections_image_admitted_update
BEFORE UPDATE OF image_object_id ON collections
FOR EACH ROW
WHEN NEW.image_object_id IS NOT NULL
  AND NEW.image_object_id IS NOT OLD.image_object_id
  AND NOT EXISTS (
    SELECT 1 FROM stored_objects AS object
    WHERE object.object_id = NEW.image_object_id
      AND object.tenant_id = NEW.tenant_id
      AND object.bucket = 'public'
      AND object.kind = 'product_media'
      AND object.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'collection image must be this tenant''s active public product media');
END;

CREATE TRIGGER catalog_version_collections_insert
AFTER INSERT ON collections
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_collections_update
AFTER UPDATE ON collections
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_collections_delete
AFTER DELETE ON collections
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = OLD.tenant_id;
END;


-- ----------------------------------------------------------------------------
-- collection_products — the members of a MANUAL collection, in the admin's
-- order (position 0 first). At most 500 per collection: the position CHECK
-- and UNIQUE (collection_id, position) hold that in the table itself. A
-- member is a product of the collection's own shop, whatever its status: the
-- public read decides what a visitor sees.
-- ----------------------------------------------------------------------------
CREATE TABLE collection_products (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  collection_id TEXT NOT NULL
    REFERENCES collections(collection_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 499),
  PRIMARY KEY (collection_id, product_id),
  UNIQUE (collection_id, position)
);

-- The foreign key's child index, and the lookup "which collections hold this
-- product".
CREATE INDEX collection_products_product_idx ON collection_products(product_id);

CREATE TRIGGER collection_products_tenant_immutable
BEFORE UPDATE OF tenant_id ON collection_products
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- The collection and the product are both of the member row's shop (the
-- tenant-match rule of 0005). A product that does not exist fails here too.
CREATE TRIGGER collection_products_tenant_matches_collection_insert
BEFORE INSERT ON collection_products
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM collections AS parent WHERE parent.collection_id = NEW.collection_id
)
BEGIN
  SELECT RAISE(ABORT, 'member tenant_id must match collection tenant_id');
END;

CREATE TRIGGER collection_products_tenant_matches_collection_update
BEFORE UPDATE ON collection_products
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM collections AS parent WHERE parent.collection_id = NEW.collection_id
)
BEGIN
  SELECT RAISE(ABORT, 'member tenant_id must match collection tenant_id');
END;

CREATE TRIGGER collection_products_tenant_matches_product_insert
BEFORE INSERT ON collection_products
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT product.tenant_id FROM products AS product WHERE product.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'member must be a product of the collection tenant');
END;

CREATE TRIGGER collection_products_tenant_matches_product_update
BEFORE UPDATE ON collection_products
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT product.tenant_id FROM products AS product WHERE product.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'member must be a product of the collection tenant');
END;

-- Members belong to a manual collection only (a smart one is its tag), in
-- both directions: no member row is added to a smart collection, and a
-- collection with member rows is not turned smart (the route removes them
-- first, in the same batch).
CREATE TRIGGER collections_smart_has_no_products
BEFORE UPDATE OF type ON collections
FOR EACH ROW
WHEN NEW.type IS NOT 'manual'
  AND EXISTS (
    SELECT 1 FROM collection_products AS member
    WHERE member.collection_id = NEW.collection_id
  )
BEGIN
  SELECT RAISE(ABORT, 'a smart collection holds no products');
END;

CREATE TRIGGER collection_products_manual_only_insert
BEFORE INSERT ON collection_products
FOR EACH ROW
WHEN (SELECT parent.type FROM collections AS parent WHERE parent.collection_id = NEW.collection_id)
  IS NOT 'manual'
BEGIN
  SELECT RAISE(ABORT, 'a smart collection holds no products');
END;

CREATE TRIGGER collection_products_manual_only_update
BEFORE UPDATE OF collection_id ON collection_products
FOR EACH ROW
WHEN (SELECT parent.type FROM collections AS parent WHERE parent.collection_id = NEW.collection_id)
  IS NOT 'manual'
BEGIN
  SELECT RAISE(ABORT, 'a smart collection holds no products');
END;

CREATE TRIGGER catalog_version_collection_products_insert
AFTER INSERT ON collection_products
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_collection_products_update
AFTER UPDATE ON collection_products
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_collection_products_delete
AFTER DELETE ON collection_products
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = OLD.tenant_id;
END;
