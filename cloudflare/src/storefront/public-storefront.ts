import {
  FEATURE_DEFAULTS,
  FEATURE_KEYS,
  type FeatureKey,
  isPlainObject,
  sanitizeStoreIdentity,
} from "../platform/tenant-config";
import { takesDestinationCharges } from "../commerce/payment";
import { isCheckoutLegallyOpen } from "../legal/legal-pages";
import { resolvePublicImages } from "../storage/public-objects";
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
import { isPreview, type StorefrontTenant } from "./preview";
import { publicShopStatement, type PublicShopRow } from "./public-shop";

interface ConnectAccountRow {
  stripe_account_id: string | null;
  stripe_charges_enabled: number;
}

export interface PublicStorefront {
  currency: string;
  locale: string;
  name: string;
}

// ── the storefront response (CP4-D) ─────────────────────────────────────────

/**
 * THE features that are ported (D81). A feature whose code is not on
 * Cloudflare reads `false` in the public response whatever the shop's row or
 * default says, so no button of it appears and fails. Porting a feature is
 * adding its key here (CP8-DC: `discountCodes`, opt-in per shop, DC1/DC2;
 * CP9-AC: `abandonedCheckout`, opt-in per shop, AC1/AC2).
 * A change here changes the storefront body without a catalog bump: raise
 * STOREFRONT_BODY_REVISION (public-routes.ts) with it.
 */
export const PORTED_FEATURE_KEYS: readonly FeatureKey[] = ["pod", "discountCodes", "abandonedCheckout"];

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
  /**
   * CP9-OB: can the shop take an order NOW? Exactly what checkout and payment
   * ask (THE legal gate `isCheckoutLegallyOpen`, and the account's
   * `takesDestinationCharges`), read with this answer. The storefront says so
   * at the cart, before a buyer fills anything in; the routes' own refusals
   * stay as the backstop. One boolean: never why.
   */
  ordersOpen: boolean;
  pickupLocations: PublicPickupLocation[];
  templateId: string | null;
  theme: PublicTheme;
}

/**
 * The same rule as the response's: a public shop (public-shop.ts: active and
 * published) with a name.
 */
export async function isPublicShop(db: D1Database, tenantId: string): Promise<boolean> {
  const row = await publicShopStatement(db, tenantId).first<PublicShopRow>();
  return row !== null && row.shop_name !== null && row.shop_name.trim() !== "";
}

/**
 * THE answer of `ordersOpen` (CP9-OB): the legal gate AND the account's own
 * test. One function, so the storefront's answer and CP9-AC's
 * `shopTakesOrders` cannot drift.
 */
export function ordersOpenOf(legallyOpen: boolean, account: ConnectAccountRow | null): boolean {
  return legallyOpen && account !== null && takesDestinationCharges(account);
}

/**
 * CP9-AC check 4: can this shop take an order NOW, as its storefront says? A
 * public shop (isPublicShop) whose `ordersOpen` would answer true. Read on its
 * own by the reminder cron step and the reminder mail, never by the
 * storefront answer (which reads the same facts in its own batch).
 */
export async function shopTakesOrders(db: D1Database, tenantId: string, now: number): Promise<boolean> {
  const [publicShop, legallyOpen, account] = await Promise.all([
    isPublicShop(db, tenantId),
    isCheckoutLegallyOpen(db, tenantId, now),
    db
      .prepare("SELECT stripe_account_id, stripe_charges_enabled FROM tenants WHERE tenant_id = ? LIMIT 1")
      .bind(tenantId)
      .first<ConnectAccountRow>(),
  ]);
  return publicShop && ordersOpenOf(legallyOpen, account);
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
 *
 * `ordersOpen` is NOT labelled by the version: the account columns change by
 * webhook or refresh with no trigger, and the terms gate closes by the clock
 * when the D47 grace ends. So its caller names it in the ETag
 * (public-routes.ts): a changed answer never meets a stale 304.
 *
 * A tenant marked `preview` (a valid grant, preview.ts) passes the shop gate
 * while unpublished, and the gallery's product links follow the preview's
 * fragment; its caller answers without the version (no-store, no ETag).
 */
export async function getPublicStorefrontVersioned(
  env: Env,
  db: D1Database,
  tenant: StorefrontTenant,
): Promise<{ catalogVersion: number; value: PublicStorefrontResponse } | null> {
  const [shopResult, settingsResult, featuresResult, accountResult, reminderResult] = await db.batch<
    | PublicShopRow
    | { store_identity_json: string }
    | { enabled: number; feature_key: string }
    | ConnectAccountRow
    | { enabled: number }
  >([
    publicShopStatement(db, tenant.tenantId, isPreview(tenant)),
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
    db
      .prepare("SELECT stripe_account_id, stripe_charges_enabled FROM tenants WHERE tenant_id = ? LIMIT 1")
      .bind(tenant.tenantId),
    // CP9-AC: the seller's own switch of Övergiven kassa (0056; its triggers
    // bump catalog_version, so the version labels it too).
    db
      .prepare("SELECT enabled FROM checkout_reminder_settings WHERE tenant_id = ? LIMIT 1")
      .bind(tenant.tenantId),
  ]);

  const shop = (shopResult?.results[0] as PublicShopRow | undefined) ?? null;
  if (shop === null || shop.shop_name === null || shop.shop_name.trim() === "") {
    return null;
  }
  const settings = settingsResult?.results[0] as { store_identity_json: string } | undefined;
  const identity = parseIdentity(settings?.store_identity_json ?? null);
  const features = publicFeatures(
    (featuresResult?.results ?? []) as Array<{ enabled: number; feature_key: string }>,
  );
  // CP9-AC §8.1: the checkout asks for the reminder box only while the shop
  // actually sends reminders: the platform's add-on (above) AND the seller's
  // switch.
  features.abandonedCheckout =
    features.abandonedCheckout && (reminderResult?.results[0] as { enabled: number } | undefined)?.enabled === 1;

  const account = (accountResult?.results[0] as ConnectAccountRow | undefined) ?? null;

  const menuEntries = storedMenu(identity.menu);
  const [images, menuResolutions, productPathsBySku, legallyOpen] = await Promise.all([
    resolvePublicImages(env, db, tenant.tenantId, identityImageIds(identity), ["shop_branding"]),
    readMenuResolutions(db, tenant.tenantId, menuEntries),
    readProductPathsBySku(db, tenant, galleryLinkSkus(identity)),
    isCheckoutLegallyOpen(db, tenant.tenantId, Date.now()),
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
      ordersOpen: ordersOpenOf(legallyOpen, account),
      pickupLocations: projectPickupLocations(identity.pickupLocations),
      templateId: projectTemplateId(identity.templateId),
      theme: projectTheme(identity.theme),
    },
  };
}
