PRAGMA foreign_keys = ON;

-- Acting-as grants: the ONLY way a platform user reaches a shop's admin surface
-- (PLAN §2.1 — "server-minted, audited, time-boxed acting-as session").
--
-- A platform admin is not a member of any shop, and deliberately never becomes
-- one: a membership row would be a standing, unbounded, silent right to act on a
-- merchant's data. A grant is the opposite on every axis. It is minted by a
-- server route that re-checks the caller's live platform_admin record, it names
-- exactly one shop, it expires on its own after a fixed window (60 minutes,
-- decided by the route and never by the client), it can be revoked early, and
-- both events land in `audit_events` beside the grant id.
--
-- The authorization check (src/auth/request-authorization.ts) accepts a grant
-- only while ALL of these hold at request time: not revoked, not expired, the
-- caller still holds an ACTIVE platform_admin identity, and the shop is still
-- active. Removing any one of them ends the session on the next request — there
-- is nothing cached to wait out.
--
-- TIME: ISO-8601 UTC TEXT written by the server (PLAN §2.8), always the exact
-- `Date.prototype.toISOString()` shape. That shape is fixed-width, so the
-- lexicographic comparisons the authorization query makes (`expires_at > ?`)
-- are chronological. The CHECKs below pin the shape so a hand-written row in a
-- different format cannot silently break that ordering: a value must survive a
-- round trip through strftime unchanged, which only the canonical
-- `YYYY-MM-DDTHH:MM:SS.sssZ` form does. `IS` rather than `=` because an
-- unparseable value makes strftime return NULL, and a CHECK that evaluates to
-- NULL would PASS. (A GLOB pattern would say the same thing more literally, but
-- D1 caps GLOB pattern length below what this shape needs.)
CREATE TABLE acting_as_grants (
  id TEXT PRIMARY KEY NOT NULL,
  -- RESTRICT, not CASCADE: a grant is evidence. Deleting the user must not
  -- erase the record that they once acted inside a merchant's shop.
  platform_user_id TEXT NOT NULL REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (
    created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  ),
  expires_at TEXT NOT NULL CHECK (
    expires_at IS strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)
  ),
  revoked_at TEXT CHECK (
    revoked_at IS NULL
    OR revoked_at IS strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at)
  ),
  -- Optional operator note ("support ticket 1234"). Bounded, never required:
  -- the audit row is the record, the reason is context for a human reading it.
  reason TEXT CHECK (reason IS NULL OR (length(reason) >= 1 AND length(reason) <= 500)),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TRIGGER acting_as_grants_tenant_immutable
BEFORE UPDATE OF tenant_id ON acting_as_grants
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

-- A grant's terms are fixed when it is minted. The one legitimate change is a
-- revocation, and that is covered by its own trigger below; widening the
-- window, re-pointing the grant at another user, or rewriting its reason would
-- each turn an audited, time-boxed permission into an unaudited one.
CREATE TRIGGER acting_as_grants_terms_immutable
BEFORE UPDATE ON acting_as_grants
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.platform_user_id IS NOT OLD.platform_user_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.reason IS NOT OLD.reason
BEGIN
  SELECT RAISE(ABORT, 'acting-as grant terms are immutable');
END;

-- Revocation is one-way: a revoked grant can never be revived, and its
-- revocation time can never be rewritten.
CREATE TRIGGER acting_as_grants_revocation_final
BEFORE UPDATE OF revoked_at ON acting_as_grants
FOR EACH ROW
WHEN OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'acting-as grant revocation is final');
END;

CREATE TRIGGER acting_as_grants_no_delete
BEFORE DELETE ON acting_as_grants
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'acting-as grants are append-only');
END;

-- The authorization lookup: one caller, one shop, unrevoked, newest expiry.
CREATE INDEX acting_as_grants_user_tenant_idx
  ON acting_as_grants(platform_user_id, tenant_id, expires_at);
-- The per-tenant index every tenant table carries (PLAN §2.7): "who has acted
-- inside this shop", newest first.
CREATE INDEX acting_as_grants_tenant_created_idx
  ON acting_as_grants(tenant_id, created_at DESC);
