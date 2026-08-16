PRAGMA foreign_keys = ON;

-- Canonical ownership record for every R2 object. The R2 key is never
-- authorization: delivery code resolves this row first and validates
-- tenant/status before it touches a bucket.
CREATE TABLE stored_objects (
  object_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  bucket TEXT NOT NULL CHECK (bucket IN ('public', 'private', 'temp')),
  object_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'artwork_original', 'print_file', 'preview_image', 'product_media',
    'shop_branding', 'document', 'export', 'temp_upload'
  )),
  content_type TEXT NOT NULL,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 TEXT,
  -- pending = key reserved before the upload finalizes; active = validated and
  -- addressable; deleted = soft tombstone that must never be delivered.
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'deleted')),
  -- Set once an object is referenced by paid or production state. From then on
  -- it may be metadata-touched but never re-pointed, re-hashed, or tombstoned.
  immutable INTEGER NOT NULL DEFAULT 0 CHECK (immutable IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (bucket, object_key),
  -- Keys must live under the owning tenant's prefix. This is a containment
  -- invariant, not an authorization check.
  --
  -- Deliberately substr()/= rather than the more obvious
  -- `object_key LIKE 'shops/' || tenant_id || '/%'`: LIKE treats `_` as a
  -- single-character wildcard and is case-insensitive for ASCII, so a tenant
  -- named `a_b` would accept keys under `shops/axb/` and tenant `abc` would
  -- accept `shops/ABC/`. substr() compares the prefix byte-exactly.
  CHECK (
    substr(object_key, 1, length('shops/' || tenant_id || '/'))
      = 'shops/' || tenant_id || '/'
  )
);

CREATE TRIGGER stored_objects_tenant_immutable
BEFORE UPDATE OF tenant_id ON stored_objects
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- A frozen object is pinned to the exact bytes a paid order references.
CREATE TRIGGER stored_objects_frozen_pointer_immutable
BEFORE UPDATE ON stored_objects
FOR EACH ROW
WHEN OLD.immutable = 1
  AND (
    NEW.object_key IS NOT OLD.object_key
    OR NEW.bucket IS NOT OLD.bucket
    OR NEW.sha256 IS NOT OLD.sha256
    OR NEW.status = 'deleted'
  )
BEGIN
  SELECT RAISE(ABORT, 'immutable object cannot be re-pointed, re-hashed, or deleted');
END;

CREATE TRIGGER stored_objects_frozen_flag_immutable
BEFORE UPDATE OF immutable ON stored_objects
FOR EACH ROW
WHEN OLD.immutable = 1 AND NEW.immutable = 0
BEGIN
  SELECT RAISE(ABORT, 'immutable objects cannot be unfrozen');
END;

CREATE INDEX stored_objects_tenant_kind_status_idx
ON stored_objects(tenant_id, kind, status);
CREATE INDEX stored_objects_bucket_status_idx ON stored_objects(bucket, status);
