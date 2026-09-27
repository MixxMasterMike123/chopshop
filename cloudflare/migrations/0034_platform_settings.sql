PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP3-D — platform settings and the screening settings (PLAN §2.3, §2.4;
-- DECISIONS D8, D9, D36, D45).
--
-- 1. platform_settings — ONE row (id = 1), the Cloudflare home of Firebase
--    `settings/platform` (functions/src/payment/platformConfig.ts) and of the
--    two scalar fields of `settings/contentScreening`
--    (screenProductOnWrite.ts:94-127). PLATFORM-only: no tenant route reads
--    it ("the seller sees one number").
--
--    default_commission_bps      the platform cut when a shop has no own
--                                `tenants.commission_bps` (Firebase
--                                defaultCommissionBps, 500 = 5 %). Read by the
--                                payment path when it freezes the fee onto a
--                                checkout (src/commerce/payment.ts); the route
--                                accepts 0..800 (D45: the PRISGOLV floor
--                                assumes at most the 8 % BAS fee).
--    refund_application_fee      PINNED to 0 by CHECK: D9 (the platform fee is
--                                not refunded) and D36 (the withholding release
--                                assumes it). The column exists so the go-live
--                                verification reads an explicit value; the
--                                code constant REFUND_APPLICATION_FEE
--                                (src/commerce/refunds.ts) is what runs.
--    reverse_dispute_on_created  Firebase reverseDisputeOnCreated (default
--                                true). Informational in CP3: the code constant
--                                REVERSE_DISPUTE_ON_CREATED
--                                (src/commerce/stripe-events.ts) is what runs,
--                                and the route refuses to edit it.
--    review_first_products       D8: a shop's first N products wait for a
--                                platform approval (Firebase
--                                reviewFirstProducts, default 2).
--    screening_hard_block        Firebase `settings/contentScreening.hardBlock`:
--                                1 = EVERY blocklist hit blocks, not only the
--                                hits on hard-block terms.
--    screening_terms_version     bumped by every change of the screening input
--                                that is not product content: a blocklist term
--                                added, changed or removed, or the global hard
--                                block switched. See 3.
--
-- 2. content_screening_terms.note — Firebase `blocklist[].note` (a human
--    remark, e.g. why a term is written in full). Nullable; '' is admitted so
--    an importer can carry Firebase's empty notes verbatim.
--
-- 3. Re-screening when the blocklist changes (PLAN §2.4). A term change is
--    screening input for EVERY live product. It takes effect in two steps:
--
--    a. At once, in the term change's own batch: every live product whose
--       STORED screened text (below) the new term set would hard-block, and
--       that is public now, is set 'blocked' in SQL — one statement, no loop.
--       So no product the new term set blocks stays public.
--    b. Later: every live product whose verdict was computed under an older
--       term set (terms_version below the current one, or NULL) is re-screened
--       by the full state machine, a bounded batch at a time
--       (rescreenStaleScreenings: the platform route
--       POST /v1/platform/screening-terms/rescreen, and the 15-minute cron once
--       wired). That also applies everything that does not block (a new
--       advisory term flags a product, a removed term un-blocks one).
--
--    product_screening gains the text its verdict was computed from:
--      screened_tokens   the tokenized haystack (word terms match here)
--      screened_raw      the NFC haystack (symbol-only terms such as ™)
--      terms_version     the platform_settings.screening_terms_version the
--                        verdict was computed under; NULL = never computed by
--                        the machine since 0034 (rows written before 0034,
--                        and a platform decision on a never-screened product).
--    Written by every machine verdict (src/catalog/screening.ts), including
--    the "nothing changes" one, which refreshes the text.
--
--    THE TERMS FENCE: a product mutation computes its verdict from the term
--    list it read BEFORE its batch. A term change committing in between must
--    not let that stale verdict land (it would have been computed without the
--    new term, and step (a) already ran over the OLD text). The two
--    product_screening_terms_current_* triggers abort any verdict stamped with
--    a terms_version other than the current one; the mutation's existing retry
--    (withScreeningRetry) re-runs it from fresh reads. Two concurrent term
--    changes fence each other through platform_settings_terms_version_forward.
--
-- TIME: ISO-8601 UTC TEXT (PLAN §2.8), the 0013/0017/0029 round-trip CHECK.
-- ============================================================================

CREATE TABLE platform_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  default_commission_bps INTEGER NOT NULL DEFAULT 500
    CHECK (default_commission_bps BETWEEN 0 AND 10000),
  refund_application_fee INTEGER NOT NULL DEFAULT 0
    CHECK (refund_application_fee = 0),
  reverse_dispute_on_created INTEGER NOT NULL DEFAULT 1
    CHECK (reverse_dispute_on_created IN (0, 1)),
  review_first_products INTEGER NOT NULL DEFAULT 2
    CHECK (review_first_products BETWEEN 0 AND 100),
  screening_hard_block INTEGER NOT NULL DEFAULT 0
    CHECK (screening_hard_block IN (0, 1)),
  screening_terms_version INTEGER NOT NULL DEFAULT 1
    CHECK (screening_terms_version >= 1),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  -- The platform user of the last change; NULL for the migration's seed and
  -- for values an import script sets.
  updated_by TEXT REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT
);

INSERT INTO platform_settings (id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TRIGGER platform_settings_terms_version_forward
BEFORE UPDATE OF screening_terms_version ON platform_settings
FOR EACH ROW
WHEN NEW.screening_terms_version <= OLD.screening_terms_version
BEGIN
  SELECT RAISE(ABORT, 'screening terms changed');
END;

ALTER TABLE content_screening_terms ADD COLUMN note TEXT CHECK (
  note IS NULL OR length(note) <= 500
);

ALTER TABLE product_screening ADD COLUMN screened_tokens TEXT CHECK (
  screened_tokens IS NULL OR length(screened_tokens) <= 65536
);

ALTER TABLE product_screening ADD COLUMN screened_raw TEXT CHECK (
  screened_raw IS NULL OR length(screened_raw) <= 65536
);

ALTER TABLE product_screening ADD COLUMN terms_version INTEGER CHECK (
  terms_version IS NULL OR terms_version >= 0
);

-- THE TERMS FENCE (3 above). Without a settings row there is no version to
-- fence on (the readers fall back to defaults); the migration seeds the row.
CREATE TRIGGER product_screening_terms_current_insert
BEFORE INSERT ON product_screening
FOR EACH ROW
WHEN NEW.terms_version IS NOT NULL
  AND EXISTS (SELECT 1 FROM platform_settings WHERE id = 1)
  AND NEW.terms_version IS NOT (
    SELECT screening_terms_version FROM platform_settings WHERE id = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'screening terms changed');
END;

CREATE TRIGGER product_screening_terms_current_update
BEFORE UPDATE OF terms_version ON product_screening
FOR EACH ROW
WHEN NEW.terms_version IS NOT NULL
  AND EXISTS (SELECT 1 FROM platform_settings WHERE id = 1)
  AND NEW.terms_version IS NOT (
    SELECT screening_terms_version FROM platform_settings WHERE id = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'screening terms changed');
END;

-- The re-screen sweep: stale verdicts first (NULL, then oldest version).
CREATE INDEX product_screening_terms_version_idx
  ON product_screening(terms_version, updated_at);
