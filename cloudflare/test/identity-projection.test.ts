import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  parseStoreSettingsInput,
  STORE_IDENTITY_IMAGE_KEYS,
  unreferencableStoreIdentityImages,
} from "../src/platform/tenant-config";
import {
  projectStoreIdentity,
  projectTheme,
  readHttpUrl,
} from "../src/storefront/identity-projection";
import {
  ensureStorefrontTables,
  publicObject,
  removeObject,
  seedShop,
  storeIdentity,
} from "./storefront-fixtures";

/**
 * CP4-D — the allowlist of the store identity (identity-projection.ts) and the
 * write rules of its branding image keys (tenant-config.ts).
 */

const NO_RESOLUTIONS = { images: new Map(), productPathsBySku: new Map(), supportEmail: null };

// Every value below is a marker that must never reach a visitor.
const SENSITIVE_IDENTITY: Record<string, unknown> = {
  commissionBps: 250,
  contactEmail: "contact-marker@private.test",
  cartRecovery: { delayHours: 3, secret: "cart-recovery-marker" },
  currency: "EUR",
  emailLogoUrl: "https://firebasestorage.googleapis.com/v0/b/x/o/email-logo-marker.png",
  faviconUrl: "https://cdn.elsewhere.test/favicon-marker.ico",
  features: { pod: true, marker: "features-marker" },
  heroImageUrl: "https://storage.googleapis.com/bucket/hero-marker.jpg",
  internalNotes: "internal-notes-marker",
  legal: {
    acceptance: { acceptedAt: "2026-09-01T00:00:00.000Z", email: "acceptance-marker@private.test", uid: "uid-marker" },
    custom: { kopvillkor: true },
    customUpdatedAt: "custom-updated-marker",
    noWithdrawalNotice: "withdrawal-notice-marker",
  },
  logoUrl: "https://cdn.elsewhere.test/logo-marker.png",
  notificationEmail: "notification-marker@private.test",
  payments: { commissionBps: 250, stripeAccountId: "acct_payments_marker" },
  platformTerms: { email: "terms-marker@private.test", version: "2026-09-07" },
  productReviews: { requestDelayDays: 7, marker: "reviews-marker" },
  published: false,
  returnAddress: "Returgatan 1 return-address-marker",
  sellerType: "company-marker",
  shopId: "shop-id-marker",
  shopName: "shop-name-marker",
  someKeyAddedTomorrow: { nested: "tomorrow-marker" },
  status: "suspended-marker",
  stripeAccountId: "acct_top_marker",
  supportEmail: "identity-support-marker@private.test",
  tenantId: "tenant-id-marker",
  trustpilot: { domain: "butik.example.test", email: "trustpilot-invite-marker@private.test" },
  vatNumber: "SE-vat-number-marker",
  vatRate: 0.12,
  vatRegistered: true,
};

const ALLOWED_IDENTITY: Record<string, unknown> = {
  address: "Butik AB<br>Storgatan 1",
  blocks: { bestseller: false, gallery: true, secret: true, story: "yes" },
  businessInfo: "Godkänd för F-skatt",
  collectionsTitle: "Samlingar",
  companyDescription: "Vi säljer bra saker.",
  featuredLimit: "6",
  featuredTitle: "Utvalt",
  frontpageCategory: "Tröjor",
  heroCtaLabel: "Handla",
  heroHeadline: "Välkommen",
  heroMark: "KS",
  heroSecondaryLabel: "Se allt",
  heroSubtitle: "Tryckt här",
  introBody: "Rad ett\n\nRad två",
  introTitle: "Om oss",
  legalName: "Butik AB",
  orgNumber: "556677-8899",
  productsSubtitle: "Allt vi har",
  productsTitle: "Produkter",
  reviewsSubtitle: "Från kunder",
  reviewsTitle: "Omdömen",
  social: {
    facebook: "https://facebook.test/butik",
    instagram: "javascript:alert(1)",
    linkedin: "https://user:pass@linkedin.test/x",
    myspace: "https://myspace.test/butik",
    website: "http://butik.example.test/",
  },
  story: [
    { secret: "s", text: "Steg ett", title: "Ett" },
    { title: "Två" },
    { text: "Tre" },
    { text: "Fyra", title: "Fyra" },
  ],
  storyTitle: "Så gör vi",
  tagline: "Kvalitet",
};

describe("the identity is an ALLOWLIST (brief D)", () => {
  it("writes an identity full of unknown and sensitive keys; the response holds none of them", async () => {
    await ensureStorefrontTables();
    const shop = await seedShop("ip-allowlist", { name: "Allowlist Butik", supportEmail: "kundtjanst@butik.test" });
    await storeIdentity(shop.tenantId, { ...SENSITIVE_IDENTITY, ...ALLOWED_IDENTITY });

    const response = await exports.default.fetch(new Request(`${shop.origin}/v1/storefront`));
    expect(response.status).toBe(200);
    const text = await response.text();

    for (const marker of [
      "marker",
      "private.test",
      "acct_",
      "firebasestorage",
      "storage.googleapis",
      "elsewhere.test",
      "Returgatan",
      "SE-vat",
      "myspace",
      "javascript:",
      "user:pass",
      "settings-json-must-not-leak",
      "ip-allowlist",
    ]) {
      expect(text, marker).not.toContain(marker);
    }

    const body = JSON.parse(text) as { storefront: { identity: Record<string, unknown> } };
    expect(body.storefront.identity).toEqual({
      address: "Butik AB<br>Storgatan 1",
      blocks: { bestseller: false, gallery: true },
      businessInfo: "Godkänd för F-skatt",
      collectionsTitle: "Samlingar",
      companyDescription: "Vi säljer bra saker.",
      featuredLimit: 6,
      featuredTitle: "Utvalt",
      frontpageCategory: "Tröjor",
      heroCtaLabel: "Handla",
      heroHeadline: "Välkommen",
      heroMark: "KS",
      heroSecondaryLabel: "Se allt",
      heroSubtitle: "Tryckt här",
      introBody: "Rad ett\n\nRad två",
      introTitle: "Om oss",
      legalName: "Butik AB",
      orgNumber: "556677-8899",
      productsSubtitle: "Allt vi har",
      productsTitle: "Produkter",
      reviewsSubtitle: "Från kunder",
      reviewsTitle: "Omdömen",
      social: { facebook: "https://facebook.test/butik", website: "http://butik.example.test/" },
      story: [{ text: "Steg ett", title: "Ett" }, { title: "Två" }, { text: "Tre" }],
      storyTitle: "Så gör vi",
      // The support address comes from `tenants`, never from the identity.
      supportEmail: "kundtjanst@butik.test",
      tagline: "Kvalitet",
      trustpilot: { domain: "butik.example.test" },
    });
  });

  it("never shows a source-storage address, even in an allowed key of a row not written by the route", () => {
    const projected = projectStoreIdentity(
      {
        address: `<img src="https://firebasestorage.googleapis.com/v0/b/x/o/a.png">`,
        gallery: [{ imageObjectId: null, label: "gs://bucket/x.png" }],
        social: {
          facebook: "https://facebook.test/ok",
          website: "https://storage.googleapis.com/bucket/site.html",
        },
        story: [{ text: "https://x.appspot.com/y", title: "Ok" }],
        tagline: "Se https://firebasestorage.googleapis.com/v0/b/x/o/t.png",
      },
      NO_RESOLUTIONS,
    );
    expect(projected).toEqual({
      gallery: [{ image: null, label: "", path: null }],
      social: { facebook: "https://facebook.test/ok" },
      story: [{ title: "Ok" }],
    });
  });

  it("projects only the keys it names, and nothing of an identity that holds only unknown keys", () => {
    expect(projectStoreIdentity(SENSITIVE_IDENTITY, NO_RESOLUTIONS)).toEqual({
      trustpilot: { domain: "butik.example.test" },
    });
    expect(projectStoreIdentity({ tomorrow: "x", __proto__: { tagline: "inherited" } }, NO_RESOLUTIONS)).toEqual({});
  });

  it.each([
    ["an empty string", ""],
    ["white space", "   "],
    ["a number", 42],
    ["an object", { text: "x" }],
    ["a control character", "Hej\u0007"],
    ["a line break in a one-line field", "Rad\nrad"],
    ["an overlong value", "x".repeat(301)],
  ])("leaves out a tagline that is %s", (_label, value) => {
    expect(projectStoreIdentity({ tagline: value }, NO_RESOLUTIONS)).toEqual({});
  });

  it.each([
    [0, undefined],
    [13, undefined],
    [2.5, undefined],
    ["12", 12],
    [1, 1],
    ["x", undefined],
  ])("reads featuredLimit %j as %j", (value, expected) => {
    expect(projectStoreIdentity({ featuredLimit: value }, NO_RESOLUTIONS).featuredLimit).toBe(expected);
  });

  it("accepts only an absolute http(s) address with no credentials for a link", () => {
    expect(readHttpUrl("https://x.test/a b")).toBe("https://x.test/a%20b");
    for (const value of ["javascript:alert(1)", "data:text/html,x", "//x.test", "/relative", "ftp://x.test", "https://u:p@x.test", 5]) {
      expect(readHttpUrl(value), String(value)).toBeUndefined();
    }
  });

  it("keeps only the theme's known token keys, and no value that could fetch or break out", () => {
    expect(
      projectTheme({
        colors: {
          accent: "#fff",
          canvas: "url(https://x.test/a.png)",
          ink: "red; background: url(x)",
          inkMuted: "\\75rl(x)",
          line: "image-set('x.png' 1x)",
          surface: "rgb(1, 2, 3)",
        },
        fonts: { body: "@import 'x'", display: "Inter" },
        layout: { density: "airy", gridCols: 4, other: "x" },
        motion: { ease: "cubic-bezier(.2,.8,.2,1)" },
        shape: { rEl: "4px", rTile: {} },
        unknown: { accent: "#000" },
      }),
    ).toEqual({
      colors: { accent: "#fff", surface: "rgb(1, 2, 3)" },
      fonts: { display: "Inter" },
      layout: { density: "airy", gridCols: 4 },
      motion: { ease: "cubic-bezier(.2,.8,.2,1)" },
      shape: { rEl: "4px" },
    });
    expect(projectTheme("not a theme")).toEqual({});
  });
});

describe("PUT /v1/admin/settings parser: the branding image keys (tenant-config.ts)", () => {
  it("accepts an object id or null in each image key and in a gallery entry", () => {
    const identity: Record<string, unknown> = {
      gallery: [{ imageObjectId: "0f6b1d7e-5b3a-4c8e-9a0d-1e2f3a4b5c6d", label: "A" }, { imageObjectId: null }],
    };
    for (const key of STORE_IDENTITY_IMAGE_KEYS) {
      identity[key] = key === "faviconObjectId" ? null : "0f6b1d7e-5b3a-4c8e-9a0d-1e2f3a4b5c6d";
    }
    expect(parseStoreSettingsInput({ storeIdentity: identity }).status).toBe("ok");
  });

  it.each([
    ["a number", { logoObjectId: 5 }],
    ["an address", { heroObjectId: "https://cdn.test/hero.png" }],
    ["a path", { faviconObjectId: "../x" }],
    ["an empty id", { emailLogoObjectId: "" }],
    ["an overlong id", { logoObjectId: "a".repeat(129) }],
    ["a bad gallery id", { gallery: [{ imageObjectId: { id: "x" } }] }],
  ])("refuses %s as an image", (_label, identity) => {
    expect(parseStoreSettingsInput({ storeIdentity: identity })).toEqual({ status: "invalid" });
  });

  it("refuses every address of the source system's storage, at any depth, naming each path", () => {
    expect(
      parseStoreSettingsInput({
        storeIdentity: {
          accent: "#fff",
          gallery: [{ imageUrl: "https://firebasestorage.googleapis.com/v0/b/x/o/g.png", label: "ok" }],
          heroImageUrl: "https://storage.googleapis.com/bucket/hero.jpg",
          nested: { deep: ["gs://bucket.firebasestorage.app/x", "https://x.appspot.com/y"] },
        },
      }),
    ).toEqual({
      keys: ["gallery[0].imageUrl", "heroImageUrl", "nested.deep[0]", "nested.deep[1]"],
      status: "refused",
    });
  });

  it("still refuses the keys it refused before, before looking at images", () => {
    expect(parseStoreSettingsInput({ storeIdentity: { logoObjectId: 5, shopName: "x" } })).toEqual({
      keys: ["shopName"],
      status: "refused",
    });
  });
});

describe("unreferencableStoreIdentityImages: may this shop use these images?", () => {
  let good: string;
  let foreign: string;
  let productMedia: string;
  let pending: string;
  let removed: string;
  let privateObject: string;

  beforeAll(async () => {
    await seedShop("ip-images");
    await seedShop("ip-images-other");
    good = await publicObject("ip-images");
    foreign = await publicObject("ip-images-other");
    productMedia = await publicObject("ip-images", { kind: "product_media" });
    pending = await publicObject("ip-images", { activate: false });
    removed = await publicObject("ip-images");
    await removeObject("ip-images", removed);
    privateObject = await publicObject("ip-images", { kind: "print_file" });
  });

  it("admits this shop's active public branding images", async () => {
    const identity = { gallery: [{ imageObjectId: good }], logoObjectId: good };
    await expect(
      unreferencableStoreIdentityImages(env, env.DB, "ip-images", JSON.stringify(identity)),
    ).resolves.toEqual([]);
  });

  it("names every reference to another shop's, a product image, a pending, a removed, a private or an unknown object", async () => {
    const identity = {
      emailLogoObjectId: pending,
      faviconObjectId: productMedia,
      gallery: [{ imageObjectId: good }, { imageObjectId: removed }, { imageObjectId: privateObject }],
      heroObjectId: "unknown-object-id",
      logoObjectId: foreign,
    };
    await expect(
      unreferencableStoreIdentityImages(env, env.DB, "ip-images", JSON.stringify(identity)),
    ).resolves.toEqual([
      "emailLogoObjectId",
      "faviconObjectId",
      "heroObjectId",
      "logoObjectId",
      "gallery[1].imageObjectId",
      "gallery[2].imageObjectId",
    ]);
  });

  it("refuses every image while the public object address is not configured", async () => {
    const identity = { logoObjectId: good };
    await expect(
      unreferencableStoreIdentityImages(
        { ...env, PUBLIC_OBJECT_BASE_URL: "http://not-https.test" } as Env,
        env.DB,
        "ip-images",
        JSON.stringify(identity),
      ),
    ).resolves.toEqual(["logoObjectId"]);
  });

  it("has nothing to check in an identity without images", async () => {
    await expect(
      unreferencableStoreIdentityImages(env, env.DB, "ip-images", JSON.stringify({ tagline: "x" })),
    ).resolves.toEqual([]);
  });
});
