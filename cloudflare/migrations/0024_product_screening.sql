PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP2-C — content screening (PLAN §2.4, DECISIONS D8, LAUNCH_TODO A11).
--
-- Ported from functions/src/catalog/contentScreening.ts (decideScreening, the
-- matcher) + screenProductOnWrite.ts. Firebase stamped `products/{id}.screening`
-- from a trigger; here the decision is computed synchronously and written in the
-- SAME batch as the mutation that changed screened content or eligibility.
--
-- STATUS (the CF vocabulary; Firebase's in brackets):
--   pending    a shop's first N=2 products awaiting a platform decision [review;
--              also a first product WITH blocklist hits]. NOT public (D8).
--   approved   a platform admin approved it [cleared]. Public.
--   flagged    blocklist hit on a product past the first-N rule. Public —
--              advisory (§11.6); the platform review queue lists it.
--   blocked    hard-blocked term, or a platform takedown [blocked/taken_down;
--              a takedown additionally stamps products.takedown_at]. Never public.
--   advisory   screened, nothing found, past the first-N rule [ok]. Public.
--
-- hits_json / earlier_hits_json carry the state machine's memory (Firebase
-- `screening.hits` / `.earlierHits`): a rename that drops a hit keeps the term
-- remembered so a platform approval sticks only while no NEW term appears.
-- ============================================================================
CREATE TABLE product_screening (
  product_id TEXT PRIMARY KEY NOT NULL REFERENCES products(product_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'flagged', 'blocked', 'advisory')),
  -- A code, never free text from a seller: first_products | blocklist_hit |
  -- hard_block | takedown | platform_approved | null (advisory).
  reason TEXT CHECK (
    reason IS NULL
    OR (length(reason) BETWEEN 1 AND 64 AND reason NOT GLOB '*[^a-z0-9_]*')
  ),
  hits_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(hits_json) AND json_type(hits_json) = 'array'
  ),
  earlier_hits_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(earlier_hits_json) AND json_type(earlier_hits_json) = 'array'
  ),
  -- D8: set on the product's FIRST screening when the shop had fewer than
  -- N=2 other publicly-eligible products; cleared only by a platform approval.
  -- While set, every automatic decision short of a block lands on 'pending'
  -- (so a first product that was hard-blocked and then renamed still waits for
  -- a human instead of going public as 'flagged').
  requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1)),
  -- 'system' for an automatic decision, else the platform user's id.
  decided_by TEXT NOT NULL CHECK (length(decided_by) BETWEEN 1 AND 128),
  decided_at TEXT NOT NULL CHECK (decided_at IS strftime('%Y-%m-%dT%H:%M:%fZ', decided_at)),
  -- Bumped on every write; a concurrent writer that read an older version
  -- loses (the upsert is guarded on it) instead of overwriting a platform
  -- decision it never saw.
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK (updated_at >= created_at)
);

CREATE TRIGGER product_screening_tenant_immutable
BEFORE UPDATE OF tenant_id ON product_screening
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER product_screening_tenant_matches_product
BEFORE INSERT ON product_screening
FOR EACH ROW
WHEN NEW.tenant_id IS NOT (SELECT tenant_id FROM products WHERE product_id = NEW.product_id)
BEGIN
  SELECT RAISE(ABORT, 'screening tenant_id must match product tenant_id');
END;

CREATE TRIGGER product_screening_version_monotonic
BEFORE UPDATE OF version ON product_screening
FOR EACH ROW
WHEN NEW.version <= OLD.version
BEGIN
  SELECT RAISE(ABORT, 'screening version must increase');
END;

CREATE INDEX product_screening_tenant_status_idx ON product_screening(tenant_id, status);
-- The platform review queue (pending/flagged/blocked, oldest first).
CREATE INDEX product_screening_status_decided_idx ON product_screening(status, decided_at);


-- ----------------------------------------------------------------------------
-- content_screening_terms — the platform blocklist (Firebase
-- `settings/contentScreening.blocklist`, 63 terms seeded by
-- scripts/seed-content-screening.cjs). PLATFORM-level, no tenant_id — the same
-- reasoning as pod_profiles: a tenant must not be able to edit what screens it.
-- Empty = no terms, and then only the first-N rule applies (Firebase's
-- "missing doc" behaviour). The write route is CP3 ("screening settings").
-- ----------------------------------------------------------------------------
CREATE TABLE content_screening_terms (
  term TEXT PRIMARY KEY NOT NULL CHECK (length(term) BETWEEN 1 AND 200),
  kind TEXT NOT NULL DEFAULT 'other' CHECK (length(kind) BETWEEN 1 AND 64),
  hard_block INTEGER NOT NULL DEFAULT 0 CHECK (hard_block IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at IS strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
);
