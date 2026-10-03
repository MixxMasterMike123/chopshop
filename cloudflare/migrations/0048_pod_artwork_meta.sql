PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP5-WG — what the artwork library needs to know about an upload besides its
-- verdict: the seller's own name for it, that the uploader confirmed their
-- right to print it, and who uploaded it (gap analysis §2d, D53).
--
-- TIME. `pod_artwork` (0012) keeps its times as INTEGER milliseconds
-- (`created_at`, `updated_at`), so the column added here does too (CP4 rule 7:
-- a column added to an OLD table follows that table).
--
-- OLD ROWS. All three columns are NULL on every row written before this
-- migration: their uploader confirmed nothing through this system and nobody
-- is recorded as their creator. The routes answer them as `label: null`,
-- `rightsConfirmedAt: null`, `createdBySelf: false`. Nothing is backfilled:
-- a confirmation that was never given cannot be invented after the fact.
--
-- NO TABLE REBUILD. `status` stays the 0012 CHECK ('processing', 'ready',
-- 'rejected'); a failed render is still answered from its render job
-- (src/pod/artwork-store.ts getFailedArtwork), not stored here.
-- ============================================================================

-- The seller's internal name for the motif ("Namn (intern etikett)" in the
-- upload modal). Shown in the admin only: no storefront answer carries it.
-- Stored trimmed; the route refuses an empty or over-long one.
ALTER TABLE pod_artwork ADD COLUMN label TEXT CHECK (
  label IS NULL OR (length(label) BETWEEN 1 AND 120 AND label = trim(label))
);

-- When the uploader confirmed they hold the rights to print the motif: the
-- SERVER's clock at the POST that created the row, never a time a client
-- sent. Written once with the row; the trigger below keeps it.
ALTER TABLE pod_artwork ADD COLUMN rights_confirmed_at INTEGER CHECK (
  rights_confirmed_at IS NULL OR rights_confirmed_at > 0
);

-- The user who created the row (the session's user id; under acting-as the
-- platform user's own id, as every audit row records it). DELIBERATELY NOT a
-- foreign key: removing a user must not be blocked by, nor rewrite, the record
-- of who confirmed the rights to a motif.
ALTER TABLE pod_artwork ADD COLUMN created_by TEXT CHECK (
  created_by IS NULL OR length(created_by) BETWEEN 1 AND 128
);

-- The confirmation and its author are evidence: once written, never changed
-- or erased by an UPDATE (the row itself may still be deleted with the
-- artwork, which the audit trail records).
CREATE TRIGGER pod_artwork_rights_immutable
BEFORE UPDATE OF rights_confirmed_at, created_by ON pod_artwork
FOR EACH ROW
WHEN (OLD.rights_confirmed_at IS NOT NULL AND NEW.rights_confirmed_at IS NOT OLD.rights_confirmed_at)
  OR (OLD.created_by IS NOT NULL AND NEW.created_by IS NOT OLD.created_by)
BEGIN
  SELECT RAISE(ABORT, 'artwork rights confirmation is immutable');
END;
