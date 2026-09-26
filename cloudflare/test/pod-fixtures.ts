import { env } from "cloudflare:workers";
import { expect } from "vitest";

import type {
  PlatformPrincipal,
  TenantAdminPrincipal,
} from "../src/auth/live-authorization";
import { createAuth } from "../src/auth/create-auth";
import type { PrinterCapabilities, PrinterInput } from "../src/pod/printers";
import { replacePrinters } from "../src/pod/printers";

/**
 * Shared fixtures for the CP2-C suites (pod-mappings, pod-publish, screening).
 * Rows are written with SQL where the path under test is not the one that
 * writes them — an artwork is 'ready' here because the render farm is CP1's
 * concern, not this checkpoint's.
 */

export const SEED_NOW = 1_787_200_000_000;
export const AUTH_ORIGIN = "https://meteorshop-stg-api.micke-ohlen.workers.dev";

/** SnapWear SKUs (docs/SnapWearDocs/snapwear-catalog.json, SNAPWEAR_SKUS). */
export const TEE_S = "2700003";
export const TEE_M = "2700004";
export const CAP = "2500170";
export const NOT_SNAPWEAR = "9999999";

export const PLATFORM: PlatformPrincipal = {
  accountType: "platform_admin",
  userId: "platform-fixture-user",
};

export function adminOf(tenantId: string, userId = `admin-${tenantId}`): TenantAdminPrincipal {
  return { accountType: "tenant_admin", role: "admin", tenantId, userId };
}

/** A two-garment printer: a tee (front 300×400, back 300×450) and a cap. */
export function testCapabilities(): PrinterCapabilities {
  return {
    models: {
      "2000": {
        garment: "tee",
        name: "Unisex Ultra Cotton Tee",
        printAreasMm: {
          back: { h: 450, offsetTopMm: 40, w: 300 },
          front: { h: 400, offsetTopMm: 30, w: 300 },
        },
      },
      TRUCKER: { garment: "cap", printAreasMm: { front: { h: 50, w: 70 } } },
    },
    skus: {
      [CAP]: { label: "Black", model: "TRUCKER" },
      [TEE_M]: { label: "White / M", model: "2000" },
      [TEE_S]: { label: "White / S", model: "2000" },
    },
  };
}

/**
 * Tee: blank 60 kr + 40 kr per print (front/back), 20 kr pocket — the Firebase
 * printshop prices (pod_printshop_prices) in öre, ex VAT. Cap: 50 + 30.
 */
export function testPrinter(overrides: Partial<PrinterInput> = {}): PrinterInput {
  return {
    capabilities: testCapabilities(),
    currency: "SEK",
    name: "Fake printer (staging)",
    printerId: "fake-printer",
    shippingCostMinor: 4_900,
    status: "active",
    tiers: [
      { blankCostMinor: 6_000, printCostsMinor: { back: 4_000, front: 4_000, pocket: 2_000 }, sku: TEE_S },
      { blankCostMinor: 6_000, printCostsMinor: { back: 4_000, front: 4_000, pocket: 2_000 }, sku: TEE_M },
      { blankCostMinor: 5_000, printCostsMinor: { front: 3_000 }, sku: CAP },
    ],
    type: "api",
    ...overrides,
  };
}

export async function seedPrinter(overrides: Partial<PrinterInput> = {}): Promise<void> {
  const result = await replacePrinters(env.DB, PLATFORM, [testPrinter(overrides)], Date.now());
  expect(result).not.toBeNull();
}

export async function seedTenant(tenantId: string, hostname: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
         tenant_id, status, shop_name, default_locale, default_currency,
         created_at, updated_at
       ) VALUES (?, 'active', ?, 'sv-SE', 'SEK', ?, ?)`,
    ).bind(tenantId, `Shop ${tenantId}`, SEED_NOW, SEED_NOW),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
         domain_id, tenant_id, hostname, kind, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, SEED_NOW, SEED_NOW),
  ]);
}

export async function seedProfile(profileId = "apparel_dtg", minDpi = 300): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO pod_profiles (
       profile_id, label, min_dpi, print_area_w_mm, print_area_h_mm,
       max_file_mb, accepted_formats_json, sort_order, active, created_at, updated_at
     ) VALUES (?, 'Textil (DTG)', ?, 300, 400, 50, '[{"ext":"png"}]', 0, 1, ?, ?)`,
  )
    .bind(profileId, minDpi, SEED_NOW, SEED_NOW)
    .run();
}

export interface ProductSeed {
  isPod?: boolean;
  name?: string;
  priceMinor?: number;
  productId: string;
  published?: boolean;
  status?: "active" | "archived" | "draft";
  variants?: Array<{ priceMinor: number; sku: string; variantId: string }>;
}

/** A product row (and optionally its live publication) written directly. */
export async function seedProduct(tenantId: string, seed: ProductSeed): Promise<void> {
  const price = seed.priceMinor ?? 29_900;
  const name = seed.name ?? `Product ${seed.productId}`;
  const statements = [
    env.DB.prepare(
      `INSERT INTO products (
         product_id, tenant_id, status, sku, name, description,
         b2c_price_minor, currency, is_pod, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'SEK', ?, ?, ?)`,
    ).bind(
      seed.productId,
      tenantId,
      seed.status ?? "active",
      `SKU-${seed.productId}`,
      name,
      price,
      seed.isPod === true ? 1 : 0,
      SEED_NOW,
      SEED_NOW,
    ),
  ];
  for (const variant of seed.variants ?? []) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO product_variants (
           variant_id, tenant_id, product_id, sku, label, price_minor, active,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        variant.variantId,
        tenantId,
        seed.productId,
        variant.sku,
        variant.sku,
        variant.priceMinor,
        SEED_NOW,
        SEED_NOW,
      ),
    );
  }
  if (seed.published === true) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO product_publications (
           product_id, tenant_id, published, public_name, public_description,
           public_price_minor, currency, projection_version, published_at, updated_at
         ) VALUES (?, ?, 1, ?, NULL, ?, 'SEK', 1, ?, ?)`,
      ).bind(seed.productId, tenantId, name, price, SEED_NOW, SEED_NOW),
    );
  }
  await env.DB.batch(statements);
}

export const PREVIEW_BYTES = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

export function hex64(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

export interface ArtworkSeed {
  artworkId: string;
  fileName?: string;
  heightPx?: number;
  profileId?: string;
  status?: "processing" | "ready" | "rejected";
  widthPx?: number;
}

/**
 * A verdict-carrying artwork row + its original, as render-jobs.ts leaves them
 * on a 'ready' completion. The preview bytes are put in the private bucket so
 * the storefront preview route has something to stream.
 */
export async function seedArtwork(tenantId: string, seed: ArtworkSeed): Promise<{
  previewKey: string;
  printKey: string;
}> {
  const objectId = `original-${seed.artworkId}`;
  const status = seed.status ?? "ready";
  const printKey = `pod/${tenantId}/print/${seed.artworkId}.png`;
  const previewKey = `pod/${tenantId}/preview/${seed.artworkId}.webp`;
  const ready = status === "ready";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO stored_objects (
         object_id, tenant_id, bucket, object_key, kind, content_type, size_bytes,
         sha256, status, immutable, created_at, updated_at
       ) VALUES (?, ?, 'private', ?, 'artwork_original', 'image/png', 1000, ?, 'active', 0, ?, ?)`,
    ).bind(
      objectId,
      tenantId,
      `shops/${tenantId}/artwork_original/${objectId}/v1/${seed.fileName ?? "motif.png"}`,
      hex64("a"),
      SEED_NOW,
      SEED_NOW,
    ),
    env.DB.prepare(
      `INSERT INTO pod_artwork (
         artwork_id, tenant_id, original_object_id, profile_id, status,
         width_px, height_px, effective_dpi, max_print_w_mm, max_print_h_mm,
         pipeline_version, notices_json, reasons_json,
         print_object_key, preview_object_key,
         print_sha256, print_bytes, preview_sha256, preview_bytes,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      seed.artworkId,
      tenantId,
      objectId,
      seed.profileId ?? "apparel_dtg",
      status,
      ready ? (seed.widthPx ?? 3_543) : null,
      ready ? (seed.heightPx ?? 4_724) : null,
      ready ? 300 : null,
      ready ? 300 : null,
      ready ? 400 : null,
      ready ? 1 : null,
      ready ? "[]" : null,
      status === "rejected" ? '[{"code":"resolution_too_low","message":"x"}]' : null,
      ready ? printKey : null,
      ready ? previewKey : null,
      ready ? hex64("b") : null,
      ready ? 5_000 : null,
      ready ? hex64("c") : null,
      ready ? PREVIEW_BYTES.length : null,
      SEED_NOW,
      SEED_NOW,
    ),
  ]);
  if (ready) {
    await env.PRIVATE_BUCKET.put(previewKey, PREVIEW_BYTES);
  }
  return { previewKey, printKey };
}

export async function catalogVersion(tenantId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT catalog_version FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ catalog_version: number }>();
  return row?.catalog_version ?? -1;
}

/**
 * A-13 DENYLIST: no key anywhere in a tenant/buyer/public body may name a
 * cost, the withholding, the supplier, the platform cut or a price tier
 * (case-insensitive substring match on every key, recursively).
 */
const DENIED_KEY_PARTS = ["productioncost", "withhold", "supplier", "cut", "printcost", "tier"];

export function expectNoCostKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoCostKeys(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    const denied = DENIED_KEY_PARTS.find((part) => lowered.includes(part));
    expect(denied, `${path}.${key} is a denied cost key`).toBeUndefined();
    expectNoCostKeys(entry, `${path}.${key}`);
  }
}

// ── sessions (only the HTTP-level cases need them) ─────────────────────────

const FIXTURE_PASSWORD = "test-password-long-enough";

export async function signUp(email: string): Promise<{ cookie: string; userId: string }> {
  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const response = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email, name: email, password: FIXTURE_PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  const body = await response.json<{ user: { id: string } }>();
  expect(response.status).toBe(200);

  await env.DB.prepare('DELETE FROM "rateLimit"').run();
  const signedIn = await createAuth(env).handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      method: "POST",
    }),
  );
  const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) {
    throw new Error("sign-in returned no session cookie");
  }
  return { cookie, userId: body.user.id };
}

export async function grantTenantAdmin(userId: string, tenantId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO identity_access (user_id, account_type, status, created_at, updated_at)
       VALUES (?, 'tenant_admin', 'active', ?, ?)`,
    ).bind(userId, SEED_NOW, SEED_NOW),
    env.DB.prepare(
      `INSERT INTO tenant_memberships (
         membership_id, tenant_id, user_id, role, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
    ).bind(`membership-${tenantId}-${userId}`, tenantId, userId, SEED_NOW, SEED_NOW),
  ]);
}

export async function grantPlatformAdmin(userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO identity_access (user_id, account_type, status, created_at, updated_at)
     VALUES (?, 'platform_admin', 'active', ?, ?)`,
  )
    .bind(userId, SEED_NOW, SEED_NOW)
    .run();
}

export function sessionRequest(
  url: string,
  method: string,
  options: { body?: unknown; cookie: string; origin?: string | null; shopId?: string },
): Request {
  const headers = new Headers({ cookie: options.cookie });
  if (options.shopId !== undefined) {
    headers.set("x-shop-id", options.shopId);
  }
  const origin = options.origin === undefined ? new URL(url).origin : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return new Request(url, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method,
  });
}
