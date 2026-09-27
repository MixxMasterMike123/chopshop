PRAGMA foreign_keys = ON;

-- ============================================================================
-- Connect account resync (CP2-A review round).
--
-- `account.updated` is applied only from a strictly newer event, ordered by the
-- event's `created` (one-second resolution). Two events in the same second
-- cannot be ordered: the handler merges them fail-closed — and, before this
-- migration, nothing ever repaired that. An onboarding burst ({off,off} then
-- {on,on} in one second) left a shop unable to take a payment with no alert.
--
-- `stripe_account_resync_needed = 1` marks such a tie. The reconciliation cron
-- retrieves the account from Stripe (authoritative, order-independent), writes
-- its flags, and clears the mark; a failing retrieval raises an alert.
--
-- `stripe_account_synced_at` changed meaning in 0026's round: it used to hold
-- the PROCESSING time and now holds the applied event's `created` (ms). Old
-- values are not comparable with event times, so they are cleared: the next
-- account.updated for each shop applies unconditionally, which is the honest
-- state of knowledge.
-- ============================================================================
ALTER TABLE tenants ADD COLUMN stripe_account_resync_needed INTEGER NOT NULL DEFAULT 0
  CHECK (stripe_account_resync_needed IN (0, 1));

UPDATE tenants SET stripe_account_synced_at = NULL;

CREATE INDEX tenants_stripe_resync_idx
  ON tenants(stripe_account_resync_needed) WHERE stripe_account_resync_needed = 1;
