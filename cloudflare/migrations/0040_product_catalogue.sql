PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP4-A — the product catalogue: everything the storefront's product pages
-- show gets a typed home (DECISIONS D82), images and tags included.
--
-- The field table (docs/cf-port/CP4_A_REPORT.md) lists every product field of
-- the source system (MIGRATION_MANIFEST row 51), who reads it, and where it
-- lives here. Only what a page that stays in the Cloudflare build shows is
-- carried; review counts are not (D81), nor the B2B fields (D82).
--
-- TIME: `products` and `product_variants` keep their integer milliseconds.
-- The two NEW tables store ISO-8601 UTC TEXT in the exact
-- Date.prototype.toISOString() shape (the strftime round-trip CHECK of 0013+).
--
-- catalog_version: every new table bumps its tenant's version on insert,
-- update and delete (0025's rule: whatever a visitor can see bumps it). The
-- new product columns are covered by 0025's `catalog_version_products_update`.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- products — the new columns.
--
--   handle             the last segment of the product's storefront address,
--                      `/product/<handle>`. The source system builds it as
--                      slugify(name + " " + size) + "_" + sku
--                      (src/utils/productUrls.js getVariantProductSlug) and
--                      finds the product by the sku after the last "_"; the
--                      Worker derives it with the same rule
--                      (src/catalog/admin-catalog.ts productHandle) and the
--                      importer writes it with that rule, so no address of
--                      the four imported shops changes (D88). A "/" in the sku
--                      becomes "-": a path segment cannot carry one.
--                      Unique per shop. NOT NULL after this migration: the
--                      rows that exist are backfilled from their sku, a writer
--                      that names none gets the same fallback by trigger, and
--                      nothing can clear it.
--   featured           the storefront's star (productSorting.js isProductFeatured).
--   sort_order         the admin's drag order; NULL = none (sorts last).
--   compare_at_price_minor  the struck-through "was" price (REA), öre.
--   category           the primary taxonomy as the seller typed it (trimmed);
--   category_key       its address form, slugify(category): /kategori/<key>.
--                      Set together or not at all (trigger below).
--   more_info          "Mer information", HTML the storefront cleans when it
--                      renders it (DOMPurify, as today).
--   size_guide         "Storleksguide", plain text.
--   size               the product's own size (part of its address and title).
--   brand, ean_code    shown in the product page's structured data.
--   stock              shown in the structured data (InStock / OutOfStock);
--                      NULL = not tracked. Nothing on Cloudflare sells by it.
--   launch_date        "Kommer snart" until this date; YYYY-MM-DD.
-- ----------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN handle TEXT CHECK (
  handle IS NULL
  OR (length(handle) BETWEEN 1 AND 1200 AND instr(handle, '/') = 0)
);

UPDATE products SET handle = replace(sku, '/', '-') WHERE handle IS NULL;

CREATE UNIQUE INDEX products_tenant_handle_idx ON products(tenant_id, handle);

-- A writer that names no handle (a test fixture, an older code path) gets the
-- sku as its handle, the same value the backfill wrote. The route and the
-- importer always name one.
CREATE TRIGGER products_handle_fill
AFTER INSERT ON products
FOR EACH ROW
WHEN NEW.handle IS NULL
BEGIN
  UPDATE products SET handle = replace(NEW.sku, '/', '-') WHERE product_id = NEW.product_id;
END;

CREATE TRIGGER products_handle_not_null
BEFORE UPDATE OF handle ON products
FOR EACH ROW
WHEN NEW.handle IS NULL
BEGIN
  SELECT RAISE(ABORT, 'products.handle cannot be cleared');
END;

ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0
  CHECK (featured IN (0, 1));

ALTER TABLE products ADD COLUMN sort_order INTEGER CHECK (
  sort_order IS NULL OR sort_order BETWEEN -1000000000 AND 1000000000
);

ALTER TABLE products ADD COLUMN compare_at_price_minor INTEGER CHECK (
  compare_at_price_minor IS NULL
  OR compare_at_price_minor BETWEEN 0 AND 100000000
);

ALTER TABLE products ADD COLUMN category TEXT CHECK (
  category IS NULL OR length(category) BETWEEN 1 AND 100
);

ALTER TABLE products ADD COLUMN category_key TEXT CHECK (
  category_key IS NULL
  OR (length(category_key) BETWEEN 1 AND 500 AND instr(category_key, '/') = 0)
);

CREATE TRIGGER products_category_pair_insert
BEFORE INSERT ON products
FOR EACH ROW
WHEN (NEW.category IS NULL) IS NOT (NEW.category_key IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'category and category_key are set together');
END;

CREATE TRIGGER products_category_pair_update
BEFORE UPDATE OF category, category_key ON products
FOR EACH ROW
WHEN (NEW.category IS NULL) IS NOT (NEW.category_key IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'category and category_key are set together');
END;

CREATE INDEX products_tenant_category_idx ON products(tenant_id, category_key);

ALTER TABLE products ADD COLUMN more_info TEXT CHECK (
  more_info IS NULL OR length(more_info) BETWEEN 1 AND 20000
);

ALTER TABLE products ADD COLUMN size_guide TEXT CHECK (
  size_guide IS NULL OR length(size_guide) BETWEEN 1 AND 5000
);

ALTER TABLE products ADD COLUMN size TEXT CHECK (
  size IS NULL OR length(size) BETWEEN 1 AND 50
);

ALTER TABLE products ADD COLUMN brand TEXT CHECK (
  brand IS NULL OR length(brand) BETWEEN 1 AND 100
);

ALTER TABLE products ADD COLUMN ean_code TEXT CHECK (
  ean_code IS NULL OR length(ean_code) BETWEEN 1 AND 32
);

ALTER TABLE products ADD COLUMN stock INTEGER CHECK (
  stock IS NULL OR stock BETWEEN 0 AND 1000000000
);

-- date() normalises an impossible day ('2026-02-30' → '2026-03-02') and
-- answers NULL for anything that is not a date, so the round trip admits
-- exactly the real calendar dates in YYYY-MM-DD.
ALTER TABLE products ADD COLUMN launch_date TEXT CHECK (
  launch_date IS NULL OR launch_date IS date(launch_date)
);


-- ----------------------------------------------------------------------------
-- product_variants — what the variant rail needs (model v2.2: a variant row
-- carries its `group`, e.g. "Svart", and its `size`, e.g. "M"). MONEY STAYS
-- KEYED ON THE VARIANT'S SKU: checkout resolves a line by variant id + active
-- and takes this row's sku and price (src/commerce/checkout.ts resolveLine);
-- none of that changes here.
--
--   variant_group   the rail's group label; NULL = an ungrouped variant (the
--                   flat picker). `group` is an SQL keyword.
--   size            the size within the group; NULL = none.
--   position        the admin's order of the rail (0 first). Rows that exist
--                   get 0 and keep their old order (label, then id).
-- ----------------------------------------------------------------------------
ALTER TABLE product_variants ADD COLUMN variant_group TEXT CHECK (
  variant_group IS NULL OR length(variant_group) BETWEEN 1 AND 100
);

ALTER TABLE product_variants ADD COLUMN size TEXT CHECK (
  size IS NULL OR length(size) BETWEEN 1 AND 50
);

ALTER TABLE product_variants ADD COLUMN position INTEGER NOT NULL DEFAULT 0
  CHECK (position BETWEEN 0 AND 10000);

CREATE INDEX product_variants_product_position_idx
  ON product_variants(product_id, position);


-- ----------------------------------------------------------------------------
-- product_images — ONE ordered list per product (position 0 first). The
-- first row whose object a visitor can see is the main image. A row with no
-- variant is the product's own; a row naming a variant is that variant's
-- GROUP's image (every size of "Svart" shows the photos of "Svart"; a variant
-- without a group shows the rows that name it), so a colour's photos are one
-- set of rows, not one per size.
--
-- `object_id` names a `stored_objects` row: product media of this shop in the
-- public bucket, active when the row is written. The address is made at read
-- time (src/storage/public-objects.ts) and never stored. The object may be
-- removed later (D93): the public reads then skip the row, and the next one
-- becomes the main image. At most 30 rows per product (position 0..29).
-- ----------------------------------------------------------------------------
CREATE TABLE product_images (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 29),
  variant_id TEXT REFERENCES product_variants(variant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  object_id TEXT NOT NULL REFERENCES stored_objects(object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  alt TEXT CHECK (alt IS NULL OR length(alt) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  PRIMARY KEY (product_id, position)
);

-- One object once per owner: twice on the product, or twice on one variant,
-- is a client bug.
CREATE UNIQUE INDEX product_images_owner_object_idx
  ON product_images(product_id, COALESCE(variant_id, ''), object_id);
CREATE INDEX product_images_tenant_product_idx ON product_images(tenant_id, product_id);
CREATE INDEX product_images_variant_idx ON product_images(variant_id);

CREATE TRIGGER product_images_tenant_immutable
BEFORE UPDATE OF tenant_id ON product_images
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER product_images_tenant_matches_product_insert
BEFORE INSERT ON product_images
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'image tenant_id must match product tenant_id');
END;

CREATE TRIGGER product_images_tenant_matches_product_update
BEFORE UPDATE ON product_images
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'image tenant_id must match product tenant_id');
END;

-- The variant is optional; when named it must be a variant of this product
-- in this shop (the checkout_items rule of 0009).
CREATE TRIGGER product_images_variant_matches_product_insert
BEFORE INSERT ON product_images
FOR EACH ROW
WHEN NEW.variant_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_variants AS variant
    WHERE variant.variant_id = NEW.variant_id
      AND variant.tenant_id = NEW.tenant_id
      AND variant.product_id = NEW.product_id
  )
BEGIN
  SELECT RAISE(ABORT, 'image variant must belong to the same tenant and product');
END;

CREATE TRIGGER product_images_variant_matches_product_update
BEFORE UPDATE ON product_images
FOR EACH ROW
WHEN NEW.variant_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM product_variants AS variant
    WHERE variant.variant_id = NEW.variant_id
      AND variant.tenant_id = NEW.tenant_id
      AND variant.product_id = NEW.product_id
  )
BEGIN
  SELECT RAISE(ABORT, 'image variant must belong to the same tenant and product');
END;

-- The object must be this shop's active product media in the public bucket
-- when the row is written: another shop's object, a private object, a
-- branding image or an upload that never finished can never be attached,
-- whoever writes the row. (The route checks the same through
-- getReferencablePublicImage first and answers 400.)
CREATE TRIGGER product_images_object_admitted_insert
BEFORE INSERT ON product_images
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM stored_objects AS object
  WHERE object.object_id = NEW.object_id
    AND object.tenant_id = NEW.tenant_id
    AND object.bucket = 'public'
    AND object.kind = 'product_media'
    AND object.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'image object must be this tenant''s active public product media');
END;

CREATE TRIGGER product_images_object_admitted_update
BEFORE UPDATE OF object_id, tenant_id ON product_images
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM stored_objects AS object
  WHERE object.object_id = NEW.object_id
    AND object.tenant_id = NEW.tenant_id
    AND object.bucket = 'public'
    AND object.kind = 'product_media'
    AND object.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'image object must be this tenant''s active public product media');
END;

CREATE TRIGGER catalog_version_product_images_insert
AFTER INSERT ON product_images
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_product_images_update
AFTER UPDATE ON product_images
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_product_images_delete
AFTER DELETE ON product_images
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = OLD.tenant_id;
END;


-- ----------------------------------------------------------------------------
-- product_tags — free-text tags in the seller's order.
--
--   tag       as the seller typed it, trimmed: the tag page shows it as its
--             title (TagPage.jsx), so its case is kept.
--   tag_key   its address form, slugify(tag): /tagg/<key>. Two tags with one
--             key are one tag. The filter of GET /v1/products and a
--             collection's tag rule match on it.
-- ----------------------------------------------------------------------------
CREATE TABLE product_tags (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tag_key TEXT NOT NULL CHECK (length(tag_key) BETWEEN 1 AND 250 AND instr(tag_key, '/') = 0),
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 50),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 19),
  PRIMARY KEY (product_id, tag_key),
  UNIQUE (product_id, position)
);

CREATE INDEX product_tags_tenant_tag_idx ON product_tags(tenant_id, tag_key);

CREATE TRIGGER product_tags_tenant_immutable
BEFORE UPDATE OF tenant_id ON product_tags
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER product_tags_tenant_matches_product_insert
BEFORE INSERT ON product_tags
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'tag tenant_id must match product tenant_id');
END;

CREATE TRIGGER product_tags_tenant_matches_product_update
BEFORE UPDATE ON product_tags
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'tag tenant_id must match product tenant_id');
END;

CREATE TRIGGER catalog_version_product_tags_insert
AFTER INSERT ON product_tags
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_product_tags_update
AFTER UPDATE ON product_tags
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = NEW.tenant_id;
END;

CREATE TRIGGER catalog_version_product_tags_delete
AFTER DELETE ON product_tags
FOR EACH ROW
BEGIN
  UPDATE tenants SET catalog_version = catalog_version + 1 WHERE tenant_id = OLD.tenant_id;
END;


-- A public object that changes status (activated, or removed under D93) bumps
-- its shop's version through 0043's triggers on public objects.
