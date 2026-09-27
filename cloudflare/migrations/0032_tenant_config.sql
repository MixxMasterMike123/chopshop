PRAGMA foreign_keys = ON;

-- ============================================================================
-- CP3-A — tenant configuration: the shop's store identity + the fields the
-- server gates checkout on, the per-shop add-on flags, and the rule that a
-- closed shop stays closed.
--
-- Firebase source: shops/{id}.storeIdentity (merge-written free-form object,
-- src/config/shopConfig.js saveShopConfig; keys src/config/store.js) and
-- shops/{id}.features (src/config/addons.js, functions/src/config/shopFeatures.ts).
-- Writers: PUT /v1/admin/settings (src/routes/admin-settings.ts),
-- PUT /v1/platform/tenants/:tenantId/features (src/routes/platform-tenants.ts),
-- and the CP3 importer (scripts/cf-port/migrate/, manifest row 56).
--
-- TIME: ISO-8601 UTC TEXT in the exact Date.prototype.toISOString() shape,
-- pinned by the strftime round-trip CHECK 0013/0014/0017/0019+ use. ACTORS:
-- `updated_by` is the writing user's id, bounded like
-- product_screening.decided_by; a non-user writer names itself ('import').
-- ============================================================================


-- ----------------------------------------------------------------------------
-- tenant_settings — one row per tenant, created by the first write. No row =
-- nothing configured yet: identity {} and every gate field unanswered.
--
--   store_identity_json   the free-form branding/content object (Firebase
--                         storeIdentity) MINUS the keys the server owns
--                         elsewhere (src/platform/tenant-config.ts
--                         REFUSED_STORE_IDENTITY_KEYS: the shop name and
--                         support email live on `tenants`, the payments block
--                         and the legal acceptance pointers in their own
--                         tables, the four gate fields in the columns below).
--                         TENANT-ADMIN READABLE, NEVER PUBLIC through CP3 code.
--
--                         Size cap 65 536 characters. The largest realistic
--                         identity (a full menu, pickup locations with a
--                         season of dates, theme overrides, hero and footer
--                         copy) is well under 16 KB; binary/base64 never
--                         belongs in a row (PLAN §2.7), and this object will
--                         be read on every storefront render once CP4 serves
--                         branding, so it stays small. The route checks the
--                         same number in UTF-8 BYTES, which is stricter.
--
--   return_address        storeIdentity.returnAddress — köpvillkor §8 and the
--                         ångerrätt page name it; the legal-readiness gate
--                         requires it (createPaymentIntent.ts
--                         legalCheckoutBlockReason). NULL = not given.
--   vat_registered        storeIdentity.vatRegistered — THREE states on
--                         purpose: NULL = not answered yet (the gate stays
--                         closed), 1 = registered, 0 = not registered.
--   vat_number            storeIdentity.vatNumber (momsreg.nr).
--   seller_type           storeIdentity.sellerType; Firebase '' = unresolved
--                         maps to NULL.
-- ----------------------------------------------------------------------------
CREATE TABLE tenant_settings (
  tenant_id TEXT PRIMARY KEY NOT NULL
    REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  store_identity_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(store_identity_json)
    AND json_type(store_identity_json) = 'object'
    AND length(store_identity_json) <= 65536
  ),
  return_address TEXT CHECK (
    return_address IS NULL OR length(return_address) BETWEEN 1 AND 1000
  ),
  vat_registered INTEGER CHECK (vat_registered IS NULL OR vat_registered IN (0, 1)),
  vat_number TEXT CHECK (vat_number IS NULL OR length(vat_number) BETWEEN 1 AND 64),
  seller_type TEXT CHECK (seller_type IS NULL OR seller_type IN ('individual', 'company')),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128)
);

CREATE TRIGGER tenant_settings_tenant_immutable
BEFORE UPDATE OF tenant_id ON tenant_settings
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;


-- ----------------------------------------------------------------------------
-- tenant_features — per-shop add-on entitlements (Firebase shops/{id}.features),
-- written by the platform only. One row = an EXPLICIT value. No row = the
-- key's default (src/platform/tenant-config.ts FEATURE_DEFAULTS): the Firebase
-- opt-in keys (pod, contentStudio, marketingMaterials) default OFF, every
-- other allowed key defaults ON. D22: the importer stores effective values.
--
-- The allowed keys are the add-ons that exist on Cloudflare. Two groups of
-- Firebase keys are NOT allowed (D22, the manifest's §f Q9 proposal; the raw
-- Firebase map stays in the archive):
--   deleted from the product (PLAN §3.3, D2): dining, ambassador, campaigns,
--                                              writers
--   not ported yet (PLAN §3.2 PORT-LATER):     affiliate, b2b
-- A not-ported key comes back, when its feature ports, through a migration
-- that replaces the two allowlist triggers below.
--
-- The key allowlist is enforced by TRIGGERS rather than a CHECK (… IN …):
-- SQLite cannot alter a CHECK, so a later add-on would need this table rebuilt
-- (see 0009 for what a rebuild costs on D1), while a trigger is replaced with
-- one DROP + CREATE in an additive migration. The CHECK keeps the shape.
-- The list MUST equal FEATURE_KEYS in src/platform/tenant-config.ts
-- (test/tenant-features.test.ts pins the two together).
-- ----------------------------------------------------------------------------
CREATE TABLE tenant_features (
  tenant_id TEXT NOT NULL
    REFERENCES tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  feature_key TEXT NOT NULL CHECK (
    length(feature_key) BETWEEN 1 AND 64 AND feature_key NOT GLOB '*[^A-Za-z0-9]*'
  ),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL CHECK (updated_at IS strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  PRIMARY KEY (tenant_id, feature_key)
);

CREATE TRIGGER tenant_features_tenant_immutable
BEFORE UPDATE OF tenant_id ON tenant_features
FOR EACH ROW
WHEN OLD.tenant_id IS NOT NEW.tenant_id
BEGIN
  SELECT RAISE(ABORT, 'tenant_id is immutable');
END;

CREATE TRIGGER tenant_features_key_allowlist_insert
BEFORE INSERT ON tenant_features
FOR EACH ROW
WHEN NEW.feature_key NOT IN (
  'abandonedCheckout', 'contentStudio', 'discountCodes',
  'marketingMaterials', 'pod', 'productReviews'
)
BEGIN
  SELECT RAISE(ABORT, 'feature_key is not an allowed feature');
END;

CREATE TRIGGER tenant_features_key_allowlist_update
BEFORE UPDATE OF feature_key ON tenant_features
FOR EACH ROW
WHEN NEW.feature_key NOT IN (
  'abandonedCheckout', 'contentStudio', 'discountCodes',
  'marketingMaterials', 'pod', 'productReviews'
)
BEGIN
  SELECT RAISE(ABORT, 'feature_key is not an allowed feature');
END;


-- ----------------------------------------------------------------------------
-- tenants.status 'closed' is FINAL. Firebase had no closed state (only the
-- reversible 'disabled' kill-switch, which maps to 'suspended'). On Cloudflare
-- 'suspended' stays the reversible off-switch and 'closed' is the tombstone:
-- POST /v1/platform/tenants/:tenantId/close moves provisioning | active |
-- suspended → closed, and nothing leaves closed — not the CP3 routes, not the
-- older activate/suspend actions, not a hand-written UPDATE. The row itself
-- stays forever (every tenant foreign key is ON DELETE RESTRICT).
--
-- Because it is final, the close route also refuses while the shop has an
-- order whose money could still come back into play: charged − refunded > 0
-- and no LOST dispute (src/platform/tenant-directory.ts
-- TENANT_HAS_REFUNDABLE_ORDER, stricter than the refund rule, checked inside
-- the close batch): after close no seller session exists to refund it. A shop
-- with live orders is SUSPENDED.
-- ----------------------------------------------------------------------------
CREATE TRIGGER tenants_closed_is_final
BEFORE UPDATE OF status ON tenants
FOR EACH ROW
WHEN OLD.status = 'closed' AND NEW.status IS NOT 'closed'
BEGIN
  SELECT RAISE(ABORT, 'a closed tenant cannot be reopened');
END;
