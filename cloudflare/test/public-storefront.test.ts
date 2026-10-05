import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { FEATURE_KEYS } from "../src/platform/tenant-config";
import { PORTED_FEATURE_KEYS } from "../src/storefront/public-storefront";
import {
  catalogVersion,
  ensureStorefrontTables,
  objectKey,
  PUBLIC_BASE,
  publicObject,
  removeObject,
  seedCollection,
  seedPage,
  seedProduct,
  seedShop,
  setFeature,
  storeIdentity,
} from "./storefront-fixtures";

const NOW = 1_787_000_000_000;

async function seedStorefront(
  tenantId: string,
  hostname: string,
  name: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (
        tenant_id, status, shop_name, support_email, default_locale,
        default_currency, settings_json, created_at, updated_at
      ) VALUES (?, 'active', ?, ?, 'sv-SE', 'SEK', ?, ?, ?)`,
    ).bind(
      tenantId,
      name,
      `private-${tenantId}@example.test`,
      JSON.stringify({ privatePaymentSetting: "must-not-leak" }),
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO tenant_domains (
        domain_id, tenant_id, hostname, kind, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'storefront', 'verified', ?, ?)`,
    ).bind(`domain-${tenantId}`, tenantId, hostname, NOW, NOW),
  ]);
}

interface StorefrontBody {
  storefront: Record<string, unknown> & {
    branding: Record<string, { url: string } | null>;
    features: Record<string, boolean>;
    identity: Record<string, unknown>;
    menu: Array<Record<string, unknown>>;
  };
}

async function readStorefront(origin: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(new Request(`${origin}/v1/storefront`, { headers }));
}

async function storefrontBody(origin: string): Promise<StorefrontBody["storefront"]> {
  const response = await readStorefront(origin);
  expect(response.status).toBe(200);
  return (await response.json<StorefrontBody>()).storefront;
}

const EMPTY_FEATURES = Object.fromEntries(
  FEATURE_KEYS.map((key) => [key, false]),
) as Record<string, boolean>;

beforeAll(async () => {
  await ensureStorefrontTables();
});

describe("GET /v1/storefront", () => {
  // CHANGED CASE (CP4-D): this pinned `{ currency, locale, name }` exactly and
  // that the support address never appears. The response now carries the
  // full public storefront, and the support address the footer prints and the
  // home's JSON-LD names is part of it (identity.supportEmail). What still
  // must never appear: the tenant's private settings_json and its id.
  it("returns only allowlisted public fields for the hostname tenant", async () => {
    await seedStorefront("tenant-route-a", "a.route.test", "Store A");
    await seedStorefront("tenant-route-b", "b.route.test", "Store B");

    const response = await exports.default.fetch(
      new Request("https://a.route.test/v1/storefront", {
        headers: {
          "x-forwarded-host": "b.route.test",
          "x-shop-id": "tenant-route-b",
        },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      storefront: {
        accent: null,
        branding: { emailLogo: null, favicon: null, hero: null, logo: null },
        currency: "SEK",
        features: EMPTY_FEATURES,
        identity: { supportEmail: "private-tenant-route-a@example.test" },
        locale: "sv-SE",
        menu: [],
        name: "Store A",
        // CP9-OB: no account, no legal pages: the shop cannot take an order.
        ordersOpen: false,
        pickupLocations: [],
        templateId: null,
        theme: {},
      },
    });
    expect(JSON.stringify(body)).not.toContain("tenant-route-b");
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
    expect(JSON.stringify(body)).not.toContain('"tenant-route-a"');
  });

  it("fails closed for an unknown hostname", async () => {
    const response = await exports.default.fetch(
      "https://unknown.route.test/v1/storefront",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Storefront not found",
      },
    });
  });

  it("does not expose the route through another method", async () => {
    await seedStorefront("tenant-route-post", "post.route.test", "Post Store");
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const response = await exports.default.fetch(
        new Request("https://post.route.test/v1/storefront", { method }),
      );

      expect(response.status, method).toBe(404);
      await response.body?.cancel();
    }
  });

  it("answers 404 for an unpublished, a suspended and a closed shop, and a shop with no name", async () => {
    const unpublished = await seedShop("sf-unpublished", { published: false });
    const suspended = await seedShop("sf-suspended", { status: "suspended" });
    const provisioning = await seedShop("sf-provisioning", { status: "provisioning" });
    const nameless = await seedShop("sf-nameless", { name: " " });
    for (const shop of [unpublished, suspended, provisioning, nameless]) {
      const response = await readStorefront(shop.origin);
      expect(response.status, shop.tenantId).toBe(404);
      expect(response.headers.get("etag"), shop.tenantId).toBeNull();
      await response.body?.cancel();
    }
  });
});

describe("the storefront response's members", () => {
  it("answers every feature key: stored or default AND ported (D81)", async () => {
    const shop = await seedShop("sf-features");
    expect((await storefrontBody(shop.origin)).features).toEqual(EMPTY_FEATURES);

    // Default-ON keys that are not ported stay off; an explicit true of a
    // not-ported key stays off; the ported opt-in key follows its row.
    for (const key of FEATURE_KEYS) {
      await setFeature(shop.tenantId, key, true);
    }
    const on = (await storefrontBody(shop.origin)).features;
    expect(Object.keys(on).sort()).toEqual([...FEATURE_KEYS].sort());
    for (const key of FEATURE_KEYS) {
      expect(on[key], key).toBe(PORTED_FEATURE_KEYS.includes(key));
    }
    expect(on.pod).toBe(true);
    expect(on.productReviews).toBe(false);
    // CP8-DC: ported (D81 reversed for this key only), opt-in per shop (DC2).
    expect(on.discountCodes).toBe(true);
    expect(on.abandonedCheckout).toBe(false);

    await setFeature(shop.tenantId, "pod", false);
    expect((await storefrontBody(shop.origin)).features.pod).toBe(false);
  });

  it("resolves the branding images to addresses, and only this shop's active public branding", async () => {
    const shop = await seedShop("sf-branding");
    const other = await seedShop("sf-branding-other");
    const logo = await publicObject(shop.tenantId, { fileName: "Logo.png" });
    const hero = await publicObject(shop.tenantId, { kind: "product_media" });
    const favicon = await publicObject(other.tenantId);
    const emailLogo = await publicObject(shop.tenantId, { activate: false });
    await storeIdentity(shop.tenantId, {
      emailLogoObjectId: emailLogo,
      faviconObjectId: favicon,
      heroObjectId: hero,
      logoObjectId: logo,
    });

    const branding = (await storefrontBody(shop.origin)).branding;
    expect(branding).toEqual({
      emailLogo: null, // pending
      favicon: null, // another shop's
      hero: null, // not a branding image
      logo: {
        contentType: "image/png",
        height: 300,
        objectId: logo,
        url: `${PUBLIC_BASE}/${await objectKey(logo)}`,
        width: 400,
      },
    });
  });

  it("gives no image at all while the public object address is not configured", async () => {
    const shop = await seedShop("sf-nobase");
    const logo = await publicObject(shop.tenantId);
    await storeIdentity(shop.tenantId, { logoObjectId: logo });
    const response = await worker.fetch(
      new Request(`${shop.origin}/v1/storefront`),
      { ...env, PUBLIC_OBJECT_BASE_URL: undefined } as unknown as Env,
    );
    const body = await response.json<StorefrontBody>();
    expect(body.storefront.branding.logo).toBeNull();
  });

  it("resolves the menu: public targets carry their path, missing or unpublished ones are left out", async () => {
    const shop = await seedShop("sf-menu");
    await seedCollection(shop.tenantId, { handle: "nyheter", title: "Nyheter" });
    await seedCollection(shop.tenantId, { handle: "hemlig", published: false, title: "Hemlig" });
    await seedPage(shop.tenantId, { content: "<p>Hej</p>", slug: "om-oss", title: "Om oss" });
    await seedPage(shop.tenantId, { content: "<p>Utkast</p>", slug: "utkast", status: "draft", title: "Utkast" });
    await storeIdentity(shop.tenantId, {
      menu: [
        { label: "Hem", target: "", type: "home" },
        { label: "Allt", type: "all-products" },
        { label: "Rökt", target: "Rökt & Gott", type: "category" },
        { label: "Nyhet", target: "Nyhet", type: "tag" },
        { label: "Nyheter", target: "nyheter", type: "collection" },
        { label: "Hemlig", target: "hemlig", type: "collection" },
        { label: "Saknas", target: "saknas", type: "collection" },
        { label: "Om oss", target: "om-oss", type: "page" },
        { label: "Utkast", target: "utkast", type: "page" },
        { label: "Blogg", target: "https://blogg.example.test/x", type: "url" },
        { label: "Skript", target: "javascript:alert(1)", type: "url" },
        { label: "Okänd", target: "x", type: "affiliate" },
        { label: "", target: "", type: "home" },
        "not an entry",
      ],
    });

    expect((await storefrontBody(shop.origin)).menu).toEqual([
      { label: "Hem", path: "/", target: "", type: "home", url: null },
      { label: "Allt", path: "/produkter", target: "", type: "all-products", url: null },
      { label: "Rökt", path: "/kategori/rokt-and-gott", target: "Rökt & Gott", type: "category", url: null },
      { label: "Nyhet", path: "/tagg/nyhet", target: "Nyhet", type: "tag", url: null },
      { label: "Nyheter", path: "/samling/nyheter", target: "nyheter", type: "collection", url: null },
      { label: "Om oss", path: "/om-oss", target: "om-oss", type: "page", url: null },
      {
        label: "Blogg",
        path: null,
        target: "https://blogg.example.test/x",
        type: "url",
        url: "https://blogg.example.test/x",
      },
    ]);
  });

  it("links a gallery tile to its product only while that product is public", async () => {
    const shop = await seedShop("sf-gallery");
    const image = await publicObject(shop.tenantId);
    await seedProduct(shop.tenantId, { handle: "mugg", name: "Mugg", sku: "SF-MUG" });
    await seedProduct(shop.tenantId, { name: "Utkast", published: false, sku: "SF-DRAFT" });
    await storeIdentity(shop.tenantId, {
      gallery: [
        { imageObjectId: image, label: "Mugg", linkSku: "SF-MUG" },
        { imageObjectId: image, label: "Utkast", linkSku: "SF-DRAFT" },
        { imageObjectId: "no-such-object", label: "Borta" },
        { imageUrl: "https://elsewhere.test/x.png", label: "Adress" },
        { imageObjectId: image, label: "Femte" },
      ],
    });

    const gallery = (await storefrontBody(shop.origin)).identity.gallery as Array<Record<string, unknown>>;
    expect(gallery).toHaveLength(4);
    expect(gallery.map((tile) => [tile.label, tile.path, (tile.image as { objectId: string } | null)?.objectId ?? null])).toEqual([
      ["Mugg", "/product/mugg", image],
      ["Utkast", null, image],
      ["Borta", null, null],
      ["Adress", null, null],
    ]);
    expect(JSON.stringify(gallery)).not.toContain("elsewhere.test");
  });

  it("answers pickup places, template, theme and accent in their allowed shapes", async () => {
    const shop = await seedShop("sf-shapes");
    await storeIdentity(shop.tenantId, {
      accent: "#0E5E63",
      pickupLocations: [
        { address: "Storgatan 1", dates: ["2026-10-01", "not-a-date", 5], hours: "10–16", id: "p1", name: "Butiken", secret: "x" },
        { name: "Utan id" },
      ],
      templateId: "sport",
      theme: {
        colors: { accent: "#123456", canvas: "url(https://track.test/p.png)", unknown: "#fff" },
        fonts: { display: "'Inter', sans-serif" },
        layout: { gridCols: 3, heroStyle: "editorial" },
        secretGroup: { a: "b" },
      },
    });

    const body = await storefrontBody(shop.origin);
    expect(body.accent).toBe("#0E5E63");
    expect(body.templateId).toBe("sport");
    expect(body.theme).toEqual({
      colors: { accent: "#123456" },
      fonts: { display: "'Inter', sans-serif" },
      layout: { gridCols: 3, heroStyle: "editorial" },
    });
    expect(body.pickupLocations).toEqual([
      { address: "Storgatan 1", dates: ["2026-10-01"], hours: "10–16", id: "p1", name: "Butiken" },
    ]);
  });
});

describe("catalog_version: the ETag of the storefront response", () => {
  async function etagOf(origin: string): Promise<string> {
    const response = await readStorefront(origin);
    expect(response.status).toBe(200);
    await response.body?.cancel();
    const etag = response.headers.get("etag");
    expect(etag).not.toBeNull();
    return etag as string;
  }

  it("answers a bodiless 304 while nothing changed", async () => {
    const shop = await seedShop("sf-etag-304");
    const etag = await etagOf(shop.origin);
    const again = await readStorefront(shop.origin, { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("moves on every write the response is built from, so no stale 304 is ever served", async () => {
    const shop = await seedShop("sf-etag-moves", { supportEmail: "hej@butik.test" });
    const logo = await publicObject(shop.tenantId);
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["the identity (insert)", () => storeIdentity(shop.tenantId, { logoObjectId: logo, tagline: "Ett" })],
      ["the identity (update)", () => storeIdentity(shop.tenantId, { logoObjectId: logo, tagline: "Två" })],
      ["a feature (insert)", () => setFeature(shop.tenantId, "pod", true)],
      ["a feature (update)", () => setFeature(shop.tenantId, "pod", false)],
      [
        "a feature (delete)",
        () => env.DB.prepare("DELETE FROM tenant_features WHERE tenant_id = ?").bind(shop.tenantId).run(),
      ],
      [
        "the support address",
        () =>
          env.DB.prepare("UPDATE tenants SET support_email = 'ny@butik.test' WHERE tenant_id = ?")
            .bind(shop.tenantId)
            .run(),
      ],
      ["the logo's object removed (D93)", () => removeObject(shop.tenantId, logo)],
    ];
    for (const [label, write] of writes) {
      const before = await etagOf(shop.origin);
      const version = await catalogVersion(shop.tenantId);
      await write();
      expect(await catalogVersion(shop.tenantId), label).toBeGreaterThan(version);
      const stale = await readStorefront(shop.origin, { "if-none-match": before });
      expect(stale.status, label).toBe(200);
      await stale.body?.cancel();
    }
    const body = await storefrontBody(shop.origin);
    expect(body.branding.logo).toBeNull();
    expect(body.identity.supportEmail).toBe("ny@butik.test");
  });

  it("does not move when the support address is written unchanged", async () => {
    const shop = await seedShop("sf-etag-same", { supportEmail: "same@butik.test" });
    const version = await catalogVersion(shop.tenantId);
    await env.DB.prepare("UPDATE tenants SET support_email = 'same@butik.test' WHERE tenant_id = ?")
      .bind(shop.tenantId)
      .run();
    expect(await catalogVersion(shop.tenantId)).toBe(version);
  });
});
