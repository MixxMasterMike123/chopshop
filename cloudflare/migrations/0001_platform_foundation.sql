PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  tenant_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'suspended', 'closed')),
  shop_name TEXT,
  support_email TEXT,
  default_locale TEXT NOT NULL DEFAULT 'sv-SE',
  default_currency TEXT NOT NULL DEFAULT 'SEK' CHECK (length(default_currency) = 3),
  settings_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TRIGGER tenants_identity_immutable
BEFORE UPDATE OF tenant_id ON tenants
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE INDEX tenants_status_idx ON tenants(status);

CREATE TABLE tenant_domains (
  domain_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  hostname TEXT NOT NULL UNIQUE CHECK (hostname = lower(hostname) AND instr(hostname, ' ') = 0),
  kind TEXT NOT NULL CHECK (kind IN ('storefront', 'admin', 'platform', 'print', 'custom', 'preview')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'disabled')),
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TRIGGER tenant_domains_tenant_immutable
BEFORE UPDATE OF tenant_id ON tenant_domains
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE INDEX tenant_domains_tenant_status_idx ON tenant_domains(tenant_id, status);

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  reason TEXT,
  request_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER audit_events_append_only_update
BEFORE UPDATE ON audit_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_append_only_delete
BEFORE DELETE ON audit_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE INDEX audit_events_tenant_created_idx ON audit_events(tenant_id, created_at DESC);
CREATE INDEX audit_events_actor_created_idx ON audit_events(actor_user_id, created_at DESC);
CREATE INDEX audit_events_resource_idx ON audit_events(resource_type, resource_id, created_at DESC);

CREATE TABLE idempotency_keys (
  scope TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_user_id TEXT,
  key_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TRIGGER idempotency_keys_tenant_immutable
BEFORE UPDATE OF tenant_id ON idempotency_keys
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE UNIQUE INDEX idempotency_keys_tenant_operation_hash_idx
ON idempotency_keys(COALESCE(tenant_id, '__platform__'), operation, key_hash);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);

CREATE TABLE outbox_events (
  outbox_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  last_attempt_at INTEGER,
  resolved_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (status <> 'processing' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (attempts <= max_attempts)
);

CREATE TRIGGER outbox_events_tenant_immutable
BEFORE UPDATE OF tenant_id ON outbox_events
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE INDEX outbox_events_due_idx ON outbox_events(status, next_attempt_at);
CREATE INDEX outbox_events_lease_idx ON outbox_events(status, lease_until);
CREATE INDEX outbox_events_aggregate_idx ON outbox_events(aggregate_type, aggregate_id, created_at);
