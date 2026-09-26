PRAGMA foreign_keys = ON;

-- A revoked grant's revocation_id is as final as its revoked_at (Codex P2 on
-- 694e559): acting_as_grants_revocation_final fires only on updates that name
-- revoked_at, so an UPDATE touching revocation_id alone could erase or reassign
-- the audit correlation of a finished revocation. Closed here.
CREATE TRIGGER acting_as_grants_revocation_id_final
BEFORE UPDATE OF revocation_id ON acting_as_grants
FOR EACH ROW
WHEN OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'acting-as grant revocation is final');
END;
