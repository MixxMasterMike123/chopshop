PRAGMA foreign_keys = ON;

-- Which revoke call ended a grant (Codex P2 on 7908e83).
--
-- A revoke stamps every live grant of one operator in one shop with the same
-- `revoked_at`, and its audit row is written in the same batch as an
-- INSERT … SELECT over "the rows this call revoked". Selecting those rows by
-- timestamp is not exact: two revoke calls in the same millisecond would share
-- it, and the second — which revoked nothing — would still audit a revocation.
-- The revoke call therefore mints a random id, stamps it beside `revoked_at`,
-- and the audit row selects on that id alone.
--
-- Set exactly when `revoked_at` is set (trigger below); immutable afterwards
-- through the existing `acting_as_grants_revocation_final` trigger, which
-- refuses any UPDATE of a revoked row's `revoked_at` — and this column only
-- ever changes together with it.
ALTER TABLE acting_as_grants ADD COLUMN revocation_id TEXT CHECK (
  revocation_id IS NULL OR length(revocation_id) = 36
);

CREATE TRIGGER acting_as_grants_revocation_id_paired
BEFORE UPDATE OF revoked_at, revocation_id ON acting_as_grants
FOR EACH ROW
-- Only for the revoking update itself: a revoked row is already frozen by
-- acting_as_grants_revocation_final, which must stay the trigger that answers.
WHEN OLD.revoked_at IS NULL
  AND ((NEW.revoked_at IS NULL) IS NOT (NEW.revocation_id IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'revoked_at and revocation_id must be set together');
END;

CREATE INDEX acting_as_grants_revocation_idx
  ON acting_as_grants(revocation_id);
