PRAGMA foreign_keys = ON;

CREATE TABLE products (
  product_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  b2c_price_minor INTEGER NOT NULL CHECK (b2c_price_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  is_pod INTEGER NOT NULL DEFAULT 0 CHECK (is_pod IN (0, 1)),
  internal_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (tenant_id, sku)
);

CREATE TRIGGER products_tenant_immutable
BEFORE UPDATE OF tenant_id ON products
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE INDEX products_tenant_status_idx ON products(tenant_id, status);

CREATE TABLE product_variants (
  variant_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  label TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  attributes_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (tenant_id, sku)
);

CREATE TRIGGER product_variants_tenant_immutable
BEFORE UPDATE OF tenant_id ON product_variants
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER product_variants_product_immutable
BEFORE UPDATE OF product_id ON product_variants
FOR EACH ROW
WHEN OLD.product_id IS NOT NEW.product_id
BEGIN
  SELECT RAISE(ABORT, 'product_id is immutable');
END;

CREATE TRIGGER product_variants_tenant_matches_product_insert
BEFORE INSERT ON product_variants
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'variant tenant_id must match product tenant_id');
END;

CREATE TRIGGER product_variants_tenant_matches_product_update
BEFORE UPDATE ON product_variants
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'variant tenant_id must match product tenant_id');
END;

CREATE INDEX product_variants_tenant_product_idx ON product_variants(tenant_id, product_id);

CREATE TABLE product_publications (
  product_id TEXT PRIMARY KEY NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  public_name TEXT NOT NULL,
  public_description TEXT,
  public_price_minor INTEGER NOT NULL CHECK (public_price_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  projection_version INTEGER NOT NULL DEFAULT 1 CHECK (projection_version >= 1),
  published_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (published = 0 OR published_at IS NOT NULL)
);

CREATE TRIGGER product_publications_tenant_immutable
BEFORE UPDATE OF tenant_id ON product_publications
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER product_publications_product_immutable
BEFORE UPDATE OF product_id ON product_publications
FOR EACH ROW
WHEN OLD.product_id IS NOT NEW.product_id
BEGIN
  SELECT RAISE(ABORT, 'product_id is immutable');
END;

CREATE TRIGGER product_publications_tenant_matches_product_insert
BEFORE INSERT ON product_publications
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'publication tenant_id must match product tenant_id');
END;

CREATE TRIGGER product_publications_tenant_matches_product_update
BEFORE UPDATE ON product_publications
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (
  SELECT parent.tenant_id FROM products AS parent WHERE parent.product_id = NEW.product_id
)
BEGIN
  SELECT RAISE(ABORT, 'publication tenant_id must match product tenant_id');
END;

CREATE INDEX product_publications_tenant_published_idx ON product_publications(tenant_id, published);
