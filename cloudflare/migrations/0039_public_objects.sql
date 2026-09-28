PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP4-P — public objects (D92): the pixel size of a public image, read from
-- its own bytes at activation (src/storage/image-sniff.ts).
--
-- Additive only: two nullable columns on 0006's `stored_objects`. The kinds
-- and the buckets stay exactly as 0006's rules list them.
--
--   width_px, height_px
--     Written once, by the activation of an upload. NULL = not an image, or an
--     image whose size was not found within the bounded read of its head (a
--     JPEG whose frame header sits behind a large profile); an upload never
--     fails for it. Integers, like every other column of this table.
-- ============================================================================
ALTER TABLE stored_objects ADD COLUMN width_px INTEGER
  CHECK (width_px IS NULL OR width_px BETWEEN 1 AND 100000);

ALTER TABLE stored_objects ADD COLUMN height_px INTEGER
  CHECK (height_px IS NULL OR height_px BETWEEN 1 AND 100000);
