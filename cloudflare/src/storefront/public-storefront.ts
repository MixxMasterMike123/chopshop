import {
  FEATURE_DEFAULTS,
  FEATURE_KEYS,
  type FeatureKey,
  isPlainObject,
  sanitizeStoreIdentity,
} from "../platform/tenant-config";
import { resolvePublicImages } from "../storage/public-objects";
import type { TenantContext } from "../tenancy/resolve-tenant";
import {
  galleryLinkSkus,
  identityImageIds,
  projectAccent,
  projectBranding,
  projectPickupLocations,
  projectStoreIdentity,
  projectTemplateId,
  projectTheme,
  type PublicBranding,
  type PublicMenuEntry,
  type PublicPickupLocation,
  type PublicStoreIdentity,
  type PublicTheme,
  readMenuResolutions,
  readProductPathsBySku,
  resolveMenu,
  storedMenu,
} from "./identity-projection";

export interface PublicStorefront {
  currency: string;
  locale: string;
  name: string;
}

interface StorefrontRow {
  default_currency: string;
  default_locale: string;
  shop_name: string | null;
}

/**
 * The shop's name, language and currency. Kept for its importer in app.ts; the
 * public route answers the full response below.
 */
export async function getPublicStorefront(
  db: D1Database,
  tenant: TenantContext,
): Promise<PublicStorefront | null> {
  const row = await db
    .prepare(
      `SELECT shop_name, default_locale, default_currency
       FROM tenants
       WHERE tenant_id = ?
         AND status = 'active'
       LIMIT 1`,
    )
    .bind(tenant.tenantId)
    .first<StorefrontRow>();

  if (row === null || row.shop_name === null || row.shop_name.trim() === "") {
    return null;
  }

  return {
    currency: row.default_currency,
    locale: row.default_locale,
    name: row.shop_name,
  };
}

// ── the storefront response (CP4-D) ─────────────────────────────────────────

/**
 * THE features that are ported (D81). A feature whose code is not on
 * Cloudflare reads `false` in the public response whatever the shop's row or
 * default says, so no button of it appears and fails. Porting a feature is
 * adding its key here.
 */
export const PORTED_FEATURE_KEYS: readonly FeatureKey[] = ["pod"];

/**
 * `GET /v1/storefront` → `{ storefront: PublicStorefrontResponse }`: one read
 * gives the storefront everything it paints from. Every member is public by
 * construction: the identity through the allowlist (identity-projection.ts),
 * images through `resolvePublicImages`, the menu with every target resolved.
 */
export interface PublicStorefrontResponse extends PublicStorefront {
  accent: string | null;
  branding: PublicBranding;
  features: Record<FeatureKey, boolean>;
  identity: PublicStoreIdentity;
  menu: PublicMenuEntry[];
  pickupLocations: PublicPickupLocation[];
  templateId: string | null;
  theme: PublicTheme;
}

interface ShopRow extends StorefrontRow {
  catalog_version: number;
  support_email: string | null;
}

/**
 * Only an ACTIVE and PUBLISHED shop has a public storefront (D57: an
 * unpublished shop is not shown; its preview is D's second pass).
 */
function shopStatement(db: D1Database, tenantId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT shop_name, default_locale, default_currency, support_email, catalog_version
       FROM tenants
       WHERE tenant_id = ?
         AND status = 'active'
         AND published = 1
       LIMIT 1`,
    )
    .bind(tenantId);
}

/** The same rule as the response's: an active, published shop with a name. */
export async function isPublicShop(db: D1Database, tenantId: string): Promise<boolean> {
  const row = await shopStatement(db, tenantId).first<ShopRow>();
  return row !== null && row.shop_name !== null && row.shop_name.trim() !== "";
}

function parseIdentity(json: string | null): Record<string, unknown> {
  if (json === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(json);
    // The refused keys go first (the admin read's rule), then the allowlist.
    return isPlainObject(parsed) ? sanitizeStoreIdentity(parsed) : {};
  } catch {
    return {};
  }
}

/** Every FEATURE_KEYS key: (explicit row ?? default) AND ported. */
export function publicFeatures(
  rows: ReadonlyArray<{ enabled: number; feature_key: string }>,
): Record<FeatureKey, boolean> {
  const explicit = new Map<string, boolean>();
  for (const row of rows) {
    explicit.set(row.feature_key, row.enabled === 1);
  }
  const features = {} as Record<FeatureKey, boolean>;
  for (const key of FEATURE_KEYS) {
    features[key] =
      PORTED_FEATURE_KEYS.includes(key) && (explicit.get(key) ?? FEATURE_DEFAULTS[key]);
  }
  return features;
}

/**
 * The storefront response with its tenant's catalog_version (the ETag, PLAN
 * §2.4). The shop row, the identity and the features are read in ONE batch —
 * one snapshot — so the version labels exactly them. The images, the menu's
 * targets and the gallery's links are read after it; each of those changes
 * bumps the version by trigger (0043 on public objects, 0041/0042 on
 * collections and pages, 0025 on products), so at worst the body is NEWER
 * than its label: one extra full response, never a stale 304.
 */
export async function getPublicStorefrontVersioned(
  env: Env,
  db: D1Database,
  tenant: TenantContext,
): Promise<{ catalogVersion: number; value: PublicStorefrontResponse } | null> {
  const [shopResult, settingsResult, featuresResult] = await db.batch<
    ShopRow | { store_identity_json: string } | { enabled: number; feature_key: string }
  >([
    shopStatement(db, tenant.tenantId),
    db
      .prepare("SELECT store_identity_json FROM tenant_settings WHERE tenant_id = ? LIMIT 1")
      .bind(tenant.tenantId),
    db
      .prepare(
        `SELECT feature_key, enabled FROM tenant_features
         WHERE tenant_id = ?
         ORDER BY feature_key
         LIMIT 64`,
      )
      .bind(tenant.tenantId),
  ]);

  const shop = (shopResult?.results[0] as ShopRow | undefined) ?? null;
  if (shop === null || shop.shop_name === null || shop.shop_name.trim() === "") {
    return null;
  }
  const settings = settingsResult?.results[0] as { store_identity_json: string } | undefined;
  const identity = parseIdentity(settings?.store_identity_json ?? null);
  const features = publicFeatures(
    (featuresResult?.results ?? []) as Array<{ enabled: number; feature_key: string }>,
  );

  const menuEntries = storedMenu(identity.menu);
  const [images, menuResolutions, productPathsBySku] = await Promise.all([
    resolvePublicImages(env, db, tenant.tenantId, identityImageIds(identity), ["shop_branding"]),
    readMenuResolutions(db, tenant.tenantId, menuEntries),
    readProductPathsBySku(db, tenant.tenantId, galleryLinkSkus(identity)),
  ]);

  return {
    catalogVersion: shop.catalog_version,
    value: {
      accent: projectAccent(identity.accent),
      branding: projectBranding(identity, images),
      currency: shop.default_currency,
      features,
      identity: projectStoreIdentity(identity, {
        images,
        productPathsBySku,
        supportEmail: shop.support_email,
      }),
      locale: shop.default_locale,
      menu: resolveMenu(menuEntries, menuResolutions),
      name: shop.shop_name,
      pickupLocations: projectPickupLocations(identity.pickupLocations),
      templateId: projectTemplateId(identity.templateId),
      theme: projectTheme(identity.theme),
    },
  };
}
