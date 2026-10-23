PRAGMA foreign_keys = ON;

-- ============================================================================
-- 0061 — shop subdomains (CP14): `<label>.<PLATFORM_SHOP_DOMAIN>`.
--
-- Numbered 0061, not 0058: the cp13-affiliate branch holds 0058–0060 and they
-- are applied on staging already (wrangler applies by file name, so this file
-- lands after them whichever branch merges first).
--
-- tenants.subdomain_label — the label the shop CHOSE (not its id): Kent's shop
--   `melodie-mc` may pick `melodiemc`. Nullable: a shop whose id is not a valid
--   label (or is reserved, or taken) has none until it picks one. Unique among
--   the labels set. The grammar is the hostname-label rule of
--   src/platform/provision-tenants.ts (lowercase a–z 0–9 and '-', not first or
--   last, 1–63 characters); SQLite has no regex, so the CHECK below spells it
--   with GLOB. The reserved list (admin, api, www, …) is the code's
--   (src/tenancy/subdomain.ts RESERVED_SUBDOMAIN_LABELS): it can grow without a
--   table rebuild.
--
-- tenant_domains.redirect_until — set ONLY on a platform hostname the shop has
--   moved away from (the label changed). Epoch ms. Until then the hostname
--   still resolves to the shop (an open tab keeps working) and the web Worker
--   301s its pages to the shop's canonical platform hostname; from then on it
--   resolves to nothing, and another shop that claims the label deletes the
--   row in the same batch as its claim. NULL on every other row.
--
-- The platform hostname of the current label is an ordinary verified
-- storefront row of tenant_domains (the one tenant rule stays: a tenant
-- resolves only from a verified hostname).
-- ============================================================================

ALTER TABLE tenants ADD COLUMN subdomain_label TEXT CHECK (
  subdomain_label IS NULL OR (
    length(subdomain_label) BETWEEN 1 AND 63
    AND subdomain_label NOT GLOB '*[^a-z0-9-]*'
    AND subdomain_label NOT GLOB '-*'
    AND subdomain_label NOT GLOB '*-'
  )
);

CREATE UNIQUE INDEX tenants_subdomain_label_idx
  ON tenants(subdomain_label) WHERE subdomain_label IS NOT NULL;

ALTER TABLE tenant_domains ADD COLUMN redirect_until INTEGER CHECK (
  redirect_until IS NULL OR redirect_until > 0
);

-- Staging backfill (a no-op anywhere else): the four imported staging shops
-- already hold a verified storefront hostname `<id>.stg-shop.invalid`
-- (HANDOVER 2026-09-28), which is exactly `<label>.<PLATFORM_SHOP_DOMAIN>` for
-- label = id and staging's PLATFORM_SHOP_DOMAIN. Setting the label makes those
-- rows the shops' platform hostnames; no row is written. Production has no
-- such rows, so nothing matches there: its shops get a label from the default
-- at creation or from PUT /v1/platform/tenants/:id/subdomain.
UPDATE tenants
SET subdomain_label = tenant_id
WHERE subdomain_label IS NULL
  AND tenant_id IN ('melodie-mc', 'ninetone', 'gif-sundsvall', 'sillmans')
  AND EXISTS (
    SELECT 1 FROM tenant_domains AS domain
    WHERE domain.tenant_id = tenants.tenant_id
      AND domain.hostname = tenants.tenant_id || '.stg-shop.invalid'
      AND domain.kind = 'storefront'
      AND domain.status = 'verified'
  );
