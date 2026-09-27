PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP2-E — the checkout legal gate, buyer consent, refund client idempotency.
--
-- 1. SELLER: platform terms (Plattformsvillkor + the PUB-avtal annex).
--    A shop may not sell until an admin of that shop has ACCEPTED the CURRENT
--    terms version, with stored evidence (who, when, which version, from
--    where). Firebase: src/utils/legalAcceptance.js recordPlatformTermsAcceptance
--    (append-only `shops/{id}/legalAcceptances` + pointer) and
--    src/config/platformTerms.js PLATFORM_TERMS_VERSION = '2026-09-07'.
--    createCheckout refuses (opaque 404) without it (src/legal/platform-terms.ts).
--
--    platform_terms_versions    one row per published version: its id, when
--                               it took effect, and the SHA-256 of the text.
--                               The CURRENT version is the latest one whose
--                               published_at <= now. Append-only.
--    platform_terms_acceptances one row per (tenant, version): the evidence.
--                               Append-only; a repeated accept is answered
--                               from the existing row.
--
--    The seeded hash is SHA-256 over the UTF-8 of
--      JSON.stringify({ version, terms: PLATFORM_TERMS_TEMPLATE,
--                       dpa: PLATFORM_DPA_TEMPLATE })
--    of src/config/platformTerms.js at version 2026-09-07 (the template source,
--    before merge fields are filled). A new version = a new migration row with
--    the new text's hash; checkout closes for every shop until it re-accepts.
--
-- 2. BUYER: consent at checkout, frozen on the checkout (`consent_json`) and
--    copied onto the order by the webhook in the order batch
--    (`orders.consent_json`, `orders.is_personalized`). Shape: src/legal/consent.ts.
--
-- 3. `products.is_personalized` — the ONLY input to "this line is
--    personalised" (no right of withdrawal, DAL 2 kap. 11 § 3 / CRD Art.
--    16(c), and only when disclosed + waived at checkout). Default 0. Firebase
--    parity: `product.isPersonalized === true`, set only by the seller's
--    explicit "Specialtillverkad / personlig produkt" toggle; the POD studio
--    publish path hard-codes false (LEGAL FIREWALL, pod-wagon/WagonManifest.js).
--    POD-ness never sets it. No CF route writes it yet (CP5 ProductForm).
--
-- 4. `refund_operations.client_key` — the admin's Idempotency-Key (a UUID),
--    UNIQUE per tenant: a retried POST after a lost response replays the same
--    operation instead of creating a second real refund.
--
-- TIME: ISO-8601 UTC TEXT (PLAN §2.8), the 0013/0014/0017 round-trip CHECK.
-- ============================================================================

CREATE TABLE platform_terms_versions (
  version TEXT PRIMARY KEY NOT NULL CHECK (
    length(version) BETWEEN 1 AND 32 AND version NOT GLOB '*[^0-9A-Za-z._-]*'
  ),
  published_at TEXT NOT NULL CHECK (published_at IS strftime('%Y-%m-%dT%H:%M:%fZ', published_at)),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);

CREATE TRIGGER platform_terms_versions_no_update
BEFORE UPDATE ON platform_terms_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'platform terms versions are append-only');
END;

CREATE TRIGGER platform_terms_versions_no_delete
BEFORE DELETE ON platform_terms_versions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'platform terms versions are append-only');
END;

CREATE INDEX platform_terms_versions_published_idx
  ON platform_terms_versions(published_at DESC, version DESC);

INSERT INTO platform_terms_versions (version, published_at, sha256, created_at)
VALUES (
  '2026-09-07',
  '2026-09-07T00:00:00.000Z',
  'ca1f708f70d0ab3b9d26d9d0647efafca77018d8a4e5dcc6bfec7c0a464c0b91',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE platform_terms_acceptances (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- The accepting admin (a member of the shop, never an acting-as platform user).
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  terms_version TEXT NOT NULL
    REFERENCES platform_terms_versions(version) ON UPDATE RESTRICT ON DELETE RESTRICT,
  accepted_at TEXT NOT NULL CHECK (accepted_at IS strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at)),
  -- Evidence of where the acceptance came from (CF-Connecting-IP, User-Agent).
  ip TEXT CHECK (ip IS NULL OR length(ip) BETWEEN 1 AND 64),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) BETWEEN 1 AND 512),
  -- { termsSha256, origin } — the hash of the accepted text and where from, bounded.
  evidence_json TEXT NOT NULL CHECK (
    json_valid(evidence_json)
    AND json_type(evidence_json) = 'object'
    AND length(evidence_json) <= 4096
  ),
  UNIQUE (tenant_id, terms_version)
);

CREATE TRIGGER platform_terms_acceptances_tenant_immutable
BEFORE UPDATE OF tenant_id ON platform_terms_acceptances
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER platform_terms_acceptances_no_update
BEFORE UPDATE ON platform_terms_acceptances
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'platform terms acceptances are append-only');
END;

CREATE TRIGGER platform_terms_acceptances_no_delete
BEFORE DELETE ON platform_terms_acceptances
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'platform terms acceptances are append-only');
END;

-- A version cannot be accepted before it exists.
CREATE TRIGGER platform_terms_acceptances_after_publication
BEFORE INSERT ON platform_terms_acceptances
FOR EACH ROW
WHEN NEW.accepted_at < (
  SELECT published_at FROM platform_terms_versions WHERE version = NEW.terms_version
)
BEGIN
  SELECT RAISE(ABORT, 'a terms version cannot be accepted before it is published');
END;

CREATE INDEX platform_terms_acceptances_tenant_idx
  ON platform_terms_acceptances(tenant_id, accepted_at DESC);

-- ── buyer consent ───────────────────────────────────────────────────────────

-- NULL only on a checkout created before 0031 (or by an engine-level caller
-- that passed none; the HTTP route always passes one). Written once by the
-- INSERT, never changed: it is evidence.
ALTER TABLE checkouts ADD COLUMN consent_json TEXT CHECK (
  consent_json IS NULL
  OR (
    json_valid(consent_json)
    AND json_type(consent_json) = 'object'
    AND length(consent_json) <= 4096
  )
);

CREATE TRIGGER checkouts_consent_frozen
BEFORE UPDATE OF consent_json ON checkouts
FOR EACH ROW
WHEN NEW.consent_json IS NOT OLD.consent_json
BEGIN
  SELECT RAISE(ABORT, 'checkout consent is frozen');
END;

ALTER TABLE orders ADD COLUMN consent_json TEXT CHECK (
  consent_json IS NULL
  OR (
    json_valid(consent_json)
    AND json_type(consent_json) = 'object'
    AND length(consent_json) <= 4096
  )
);

-- 1 = the order holds at least one personalised line whose withdrawal right
-- the buyer waived after the disclosure (consent_json.withdrawal). Never 1
-- without the consent that proves it.
ALTER TABLE orders ADD COLUMN is_personalized INTEGER NOT NULL DEFAULT 0 CHECK (
  is_personalized IN (0, 1)
  AND (is_personalized = 0 OR consent_json IS NOT NULL)
);

CREATE TRIGGER orders_consent_immutable
BEFORE UPDATE OF consent_json, is_personalized ON orders
FOR EACH ROW
WHEN NEW.consent_json IS NOT OLD.consent_json
  OR NEW.is_personalized IS NOT OLD.is_personalized
BEGIN
  SELECT RAISE(ABORT, 'order consent is immutable');
END;

ALTER TABLE products ADD COLUMN is_personalized INTEGER NOT NULL DEFAULT 0
  CHECK (is_personalized IN (0, 1));

-- ── refund client idempotency ───────────────────────────────────────────────

ALTER TABLE refund_operations ADD COLUMN client_key TEXT CHECK (
  client_key IS NULL
  OR (
    origin = 'admin'
    AND length(client_key) = 36
    AND client_key NOT GLOB '*[^0-9a-f-]*'
  )
);

CREATE UNIQUE INDEX refund_operations_client_key_idx
  ON refund_operations(tenant_id, client_key)
  WHERE client_key IS NOT NULL;

CREATE TRIGGER refund_operations_client_key_immutable
BEFORE UPDATE OF client_key ON refund_operations
FOR EACH ROW
WHEN NEW.client_key IS NOT OLD.client_key
BEGIN
  SELECT RAISE(ABORT, 'refund operation client key is immutable');
END;
