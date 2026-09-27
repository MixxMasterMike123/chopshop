PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP2-D2 Codex fix — the withholding-release executor can no longer starve.
--
-- The executor (src/commerce/withholding-release.ts) took the 50 oldest
-- unsettled releases each reconciliation run, and a row that failed early
-- (the fee lookup, the refund listing) was left untouched — so 50 rows that
-- fail forever occupied every batch and newer, processable releases were
-- never looked at: other shops' withholdings were never returned.
--
-- Now EVERY attempt is stamped before anything else happens (a guarded CAS
-- on `attempts`, which doubles as the run's claim on the row):
--
--   attempts          + 1 per EXECUTION attempt (0028 counted create calls;
--                     from 0030 it counts every attempted run of the row).
--   last_attempt_at   when the latest attempt started.
--   next_attempt_at   not before this is the row attempted again: 10, 20, 40
--                     … minutes, capped at 6 hours. The executor selects
--                     `next_attempt_at <= now ORDER BY next_attempt_at,
--                     created_at`, so a row that just failed goes to the back
--                     and a fresh row (the epoch default) to the front.
--
-- After the last attempt (10) a row that still has not settled moves to
-- `failed` with a critical alert, in one batch — never silently dropped.
--
-- TIME: ISO-8601 UTC TEXT (PLAN §2.8), the 0013/0014/0017 round-trip CHECK.
-- ============================================================================

-- The epoch default: every existing row, and every row the reservation /
-- discovery statements insert, is due at once.
ALTER TABLE withholding_releases ADD COLUMN next_attempt_at TEXT NOT NULL
  DEFAULT '1970-01-01T00:00:00.000Z'
  CHECK (next_attempt_at IS strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at));

ALTER TABLE withholding_releases ADD COLUMN last_attempt_at TEXT CHECK (
  last_attempt_at IS NULL OR last_attempt_at IS strftime('%Y-%m-%dT%H:%M:%fZ', last_attempt_at)
);

CREATE INDEX withholding_releases_due_idx
  ON withholding_releases(state, next_attempt_at, created_at);
