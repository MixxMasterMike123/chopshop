PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP3-E — legal evidence: the seller's adoption of its legal pages, the
-- archived text of each platform-terms version, and the publish order the
-- D47 grace rule depends on.
--
-- Two contracts, kept apart:
--   1. PLATFORM TERMS (0031): platform <-> seller. New acceptances keep going to
--      platform_terms_acceptances. This file adds only
--        - platform_terms_texts: the archived text of a version, whose SHA-256
--          must equal the version's own hash (the evidence holds the hash, the
--          archive holds the text it is the hash of);
--        - a publish-order trigger: a new version is published strictly AFTER
--          every existing one, so "the immediately previous version" (D54) is
--          always one well-defined row.
--   2. LEGAL PAGES (new): the seller adopting the consumer-facing pages of its
--      own shop (kopvillkor, angerratt, integritetspolicy) with a snapshot of
--      the exact text adopted. Firebase: src/utils/legalAcceptance.js
--      recordLegalAcceptance (`shops/{id}/legalAcceptances`, type legalPages).
--      Imported history (manifest row 65) may also carry type platformTerms.
--      A legal-pages acceptance is one of the three conditions of the checkout
--      readiness gate (src/legal/legal-pages.ts isLegallyReady; the other two
--      live in 0032 tenant_settings).
--
-- EVIDENCE IS IMMUTABLE: both new tables are append-only (no UPDATE, no
-- DELETE), like 0031. A stored snapshot is never rewritten, not even to fix a
-- URL inside it.
--
-- TIME: ISO-8601 UTC TEXT with the round-trip CHECK (PLAN §2.8, as in 0031).
-- ============================================================================

-- ── legal_acceptances ───────────────────────────────────────────────────────
--
-- texts_json    the snapshot: a JSON object (page key -> HTML for legalPages).
--               The Worker stores the CANONICAL form. Capped at 262144 BYTES
--               (256 KiB, UTF-8): the three current templates render to about
--               17 KB of JSON (src/config/legalTemplates.js, 14 KB of markdown
--               source), so the cap leaves 15x headroom for seller-edited
--               (copy-on-write) pages while staying far below D1's 2 MB row
--               limit. length(CAST(... AS BLOB)) counts bytes, not characters.
-- texts_sha256  SHA-256 (lowercase hex) of the UTF-8 bytes of the CANONICAL
--               form of texts_json:
--                 JSON.stringify(sortKeysDeep(value))
--               where sortKeysDeep rebuilds every plain object with its keys
--               inserted in Object.keys(o).sort() order (UTF-16 code unit
--               order), recursively, arrays kept in order — exactly
--               scripts/cf-port/migrate/lib/typed-json.mjs canonicalStringify.
--               ECMAScript then emits integer-like keys ("9", "10") first in
--               ascending numeric order; JSON.stringify's own escaping, no
--               whitespace. Same function in src/legal/legal-pages.ts.
-- user_id       the accepting user (a Worker row always has one).
-- legacy_uid    an imported row's original Firebase uid, verbatim; user_id is
--               then the mapped user, or NULL when the uid is not carried.
-- accepted_at_original  an imported row's acceptedAtIso string, verbatim.
-- is_custom     1 = at least one page is the seller's own text (copy-on-write).
-- custom_json   the PER-PAGE custom map, exactly as Firebase stores it
--               (storeIdentity.legal.custom, copied into the acceptance:
--               { <pageKey>: boolean } for any subset of the three keys), so the
--               evidence survives the import without loss. NULL when the
--               acceptance carried only the summary flag. A JSON object of at
--               most 1024 bytes (three short keys and booleans need ~70).
--               When present, is_custom must say exactly whether any value in
--               it is true (trigger below).
-- source        'worker' = written by POST /v1/admin/legal/accept-pages;
--               'import' = written by the CP3 importer.
CREATE TABLE legal_acceptances (
  acceptance_id TEXT PRIMARY KEY NOT NULL CHECK (length(acceptance_id) BETWEEN 1 AND 128),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('legalPages', 'platformTerms')),
  user_id TEXT REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  legacy_uid TEXT CHECK (legacy_uid IS NULL OR length(legacy_uid) BETWEEN 1 AND 128),
  email TEXT CHECK (email IS NULL OR length(email) <= 320),
  accepted_at TEXT NOT NULL CHECK (accepted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at)),
  accepted_at_original TEXT CHECK (
    accepted_at_original IS NULL OR length(accepted_at_original) BETWEEN 1 AND 64
  ),
  template_version TEXT CHECK (template_version IS NULL OR length(template_version) BETWEEN 1 AND 64),
  version TEXT CHECK (version IS NULL OR length(version) BETWEEN 1 AND 64),
  is_pod INTEGER CHECK (is_pod IS NULL OR is_pod IN (0, 1)),
  is_custom INTEGER CHECK (is_custom IS NULL OR is_custom IN (0, 1)),
  custom_json TEXT CHECK (
    custom_json IS NULL
    OR (
      json_valid(custom_json)
      AND json_type(custom_json) = 'object'
      AND length(CAST(custom_json AS BLOB)) <= 1024
    )
  ),
  texts_json TEXT NOT NULL CHECK (
    json_valid(texts_json)
    AND json_type(texts_json) = 'object'
    AND length(CAST(texts_json AS BLOB)) <= 262144
  ),
  texts_sha256 TEXT NOT NULL CHECK (length(texts_sha256) = 64 AND texts_sha256 NOT GLOB '*[^0-9a-f]*'),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 2048),
  ip TEXT CHECK (ip IS NULL OR length(ip) BETWEEN 1 AND 64),
  source TEXT NOT NULL CHECK (source IN ('worker', 'import')),
  -- Someone accepted: a mapped user, or at least the original uid.
  CHECK (user_id IS NOT NULL OR legacy_uid IS NOT NULL),
  -- An imported row always keeps its original uid (manifest row 65).
  CHECK (source <> 'import' OR legacy_uid IS NOT NULL),
  -- A Worker row is a legal-pages adoption by a real user, nothing imported:
  -- new platform-terms acceptances go to platform_terms_acceptances (0031).
  CHECK (
    source <> 'worker'
    OR (
      type = 'legalPages'
      AND user_id IS NOT NULL
      AND legacy_uid IS NULL
      AND accepted_at_original IS NULL
    )
  )
);

-- is_custom is the summary of custom_json whenever the map is kept (SQLite
-- forbids the subquery this needs inside a CHECK).
CREATE TRIGGER legal_acceptances_custom_summary
BEFORE INSERT ON legal_acceptances
FOR EACH ROW
WHEN NEW.custom_json IS NOT NULL
  AND json_valid(NEW.custom_json)
  AND NEW.is_custom IS NOT (
    EXISTS (SELECT 1 FROM json_each(NEW.custom_json) WHERE type = 'true')
  )
BEGIN
  SELECT RAISE(ABORT, 'is_custom must say whether any page in custom_json is custom');
END;

CREATE TRIGGER legal_acceptances_no_update
BEFORE UPDATE ON legal_acceptances
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'legal acceptances are append-only');
END;

CREATE TRIGGER legal_acceptances_no_delete
BEFORE DELETE ON legal_acceptances
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'legal acceptances are append-only');
END;

-- Tenant-first: "the shop's latest acceptance of this type", and the
-- readiness gate's "does one exist".
CREATE INDEX legal_acceptances_tenant_type_idx
  ON legal_acceptances(tenant_id, type, accepted_at DESC, acceptance_id DESC);

-- ── platform_terms_texts ────────────────────────────────────────────────────
--
-- The archived text of a platform-terms version: the exact UTF-8 bytes whose
-- SHA-256 is platform_terms_versions.sha256, stored in the PRIVATE R2 bucket.
--
-- NOT a stored_objects row, on purpose (the 0012 `pod/` precedent): that table
-- requires a tenant and a `shops/{tenant}/` key, and every row in it is
-- addressable by its tenant through /v1/admin/objects (read, and soft-delete
-- while mutable). Platform terms belong to no tenant, and their evidence must
-- be reachable by no tenant route except GET /v1/admin/legal/terms (current
-- version only). The key lives under a `platform/legal/terms/` prefix that no
-- other code reads or writes, and is pinned by CHECK: content-addressed by
-- (version, sha256), so the bytes behind a key never change.
--
-- One row per version, insert-once (PK). The 0031 seed (2026-09-07) has none
-- until a platform user attaches the text whose hash equals the seeded one.
CREATE TABLE platform_terms_texts (
  version TEXT PRIMARY KEY NOT NULL
    REFERENCES platform_terms_versions(version) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  object_key TEXT NOT NULL UNIQUE CHECK (
    object_key = 'platform/legal/terms/' || version || '/' || sha256 || '.txt'
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144),
  archived_by TEXT NOT NULL REFERENCES "user" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  archived_at TEXT NOT NULL CHECK (archived_at IS strftime('%Y-%m-%dT%H:%M:%fZ', archived_at))
);

-- The archive holds the text the evidence is the hash of, or nothing.
CREATE TRIGGER platform_terms_texts_hash_matches
BEFORE INSERT ON platform_terms_texts
FOR EACH ROW
WHEN NEW.sha256 IS NOT (SELECT sha256 FROM platform_terms_versions WHERE version = NEW.version)
BEGIN
  SELECT RAISE(ABORT, 'archived terms text must hash to the version sha256');
END;

CREATE TRIGGER platform_terms_texts_no_update
BEFORE UPDATE ON platform_terms_texts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'platform terms texts are append-only');
END;

CREATE TRIGGER platform_terms_texts_no_delete
BEFORE DELETE ON platform_terms_texts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'platform terms texts are append-only');
END;

-- ── publish order (D47 / D54) ───────────────────────────────────────────────
--
-- A NEW version must be published strictly after every existing version
-- (scheduled ones included). Equal times are refused too: with a tie, "the
-- immediately previous version" would hang on the label's sort order. The
-- NOT EXISTS keeps a repeated INSERT of an EXISTING version (INSERT OR IGNORE)
-- falling through to the primary key, as before. Race-safe: of two concurrent
-- publishes, the one that commits second is checked against the first.
-- Existing rows need no value: 0031 already stores published_at.
CREATE TRIGGER platform_terms_versions_publish_order
BEFORE INSERT ON platform_terms_versions
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM platform_terms_versions WHERE version = NEW.version)
  AND EXISTS (SELECT 1 FROM platform_terms_versions WHERE published_at >= NEW.published_at)
BEGIN
  SELECT RAISE(ABORT, 'a terms version must be published after the latest existing version');
END;
