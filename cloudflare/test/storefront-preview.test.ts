import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { publishAdminProduct } from "../src/catalog/admin-catalog";
import { PUBLIC_ELIGIBILITY_PREDICATE } from "../src/catalog/eligibility";
import { createMapping } from "../src/pod/pod-mappings";
import {
  mintPreviewGrant,
  PREVIEW_ELIGIBILITY_PREDICATE,
  PREVIEW_GRANT_TTL_MS,
  PREVIEW_HEADER,
  verifyPreviewGrant,
  withoutPublishedTerm,
} from "../src/storefront/preview";
import { publicShopTerms } from "../src/storefront/public-shop";
import {
  adminOf,
  PREVIEW_BYTES,
  seedArtwork,
  seedPrinter,
  seedProduct as seedPodProduct,
  seedProfile,
  seedTenant as seedPodTenant,
  TEE_S,
} from "./pod-fixtures";
import {
  ADMIN,
  approveProduct,
  bootstrapPlatform,
  buyProduct,
  call,
  type CallOptions,
  claimReceipt,
  createPlainProduct,
  createTenant,
  expectJson,
  openCheckout,
  type PaidOrder,
  paymentCall,
  publishProduct,
  readBuyerOrder,
  SLICE_RECIPIENT,
  SliceWorld,
  type Tenant,
  unique,
} from "./slice-harness";
import {
  seedCollection,
  seedPage,
  seedProduct as seedCatalogueProduct,
  seedShop,
} from "./storefront-fixtures";
import { auditCount, auditRows, expectOpaque404, platform } from "./tenant-fixtures";

/**
 * CP4-D2 — the preview of an unpublished shop (D57).
 *
 * 1. The preview's fragment is THE predicate minus exactly `tenant.published
 *    = 1`, and the preview's shop gate the public one minus `published = 1`.
 * 2. The grant: bound to its shop, 30 minutes, signed with a key derived for
 *    this purpose alone.
 * 3. `POST /v1/admin/preview`: the shop's admin only, same origin, audited.
 * 4. Every public read: an invalid grant changes NOTHING (byte for byte the
 *    answer without one); a valid one reads the unpublished shop exactly as
 *    it would read once published, `no-store`, no ETag, `noindex`.
 * 5. Every write ignores the grant: a preview never sells.
 */

const lines = (sql: string): string[] =>
  sql
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

// ═══════════════════════════════════════════════════════════════════════════
describe("the preview's fragment is derived from THE predicate in one place", () => {
  it("differs from THE predicate in exactly the `tenant.published = 1` term", () => {
    const publicLines = lines(PUBLIC_ELIGIBILITY_PREDICATE);
    const index = publicLines.indexOf("AND tenant.published = 1");
    expect(index).toBeGreaterThan(-1);
    expect([...publicLines.slice(0, index), ...publicLines.slice(index + 1)]).toEqual(
      lines(PREVIEW_ELIGIBILITY_PREDICATE),
    );
    // And as text: nothing else moved, not even whitespace.
    expect(PUBLIC_ELIGIBILITY_PREDICATE.replace(/\n[ \t]*AND tenant\.published = 1/, "")).toBe(
      PREVIEW_ELIGIBILITY_PREDICATE,
    );
    expect(PREVIEW_ELIGIBILITY_PREDICATE).not.toContain("published = 1\n     AND (screening");
    expect(PREVIEW_ELIGIBILITY_PREDICATE).not.toContain("tenant.published");
    for (const kept of [
      "publication.published = 1",
      "product.status = 'active'",
      "product.takedown_at IS NULL",
      "tenant.status = 'active'",
      "screening.status IS NULL",
      "eligible_mapping.status = 'active'",
      "suspended_mapping.status = 'suspended'",
    ]) {
      expect(PREVIEW_ELIGIBILITY_PREDICATE, kept).toContain(kept);
    }
  });

  it("refuses loudly when the predicate changes shape, rather than guessing", () => {
    const shapes = {
      inline: PUBLIC_ELIGIBILITY_PREDICATE.replace(
        "\n     AND tenant.published = 1",
        " AND tenant.published = 1",
      ),
      missing: PUBLIC_ELIGIBILITY_PREDICATE.replace("\n     AND tenant.published = 1", ""),
      "no status term": PUBLIC_ELIGIBILITY_PREDICATE.replace("AND tenant.status = 'active'", ""),
      "other spelling": PUBLIC_ELIGIBILITY_PREDICATE.replace(
        "tenant.published = 1",
        "tenant.published <> 0",
      ),
      twice: `${PUBLIC_ELIGIBILITY_PREDICATE}\n     AND tenant.published = 1\n`,
      "named elsewhere": `${PUBLIC_ELIGIBILITY_PREDICATE}\n     AND (tenant.published IS NOT NULL)`,
    };
    for (const [label, shape] of Object.entries(shapes)) {
      expect(() => withoutPublishedTerm(shape), label).toThrow(/eligibility\.ts/);
    }
    expect(withoutPublishedTerm(PUBLIC_ELIGIBILITY_PREDICATE)).toBe(PREVIEW_ELIGIBILITY_PREDICATE);
  });

  it("the shop gate of a preview is the public one minus `published = 1`, exactly", () => {
    const publicTerms = publicShopTerms(false);
    const previewTerms = publicShopTerms(true);
    expect(publicTerms.filter((term) => !previewTerms.includes(term))).toEqual(["published = 1"]);
    expect(previewTerms.every((term) => publicTerms.includes(term))).toBe(true);
    expect(previewTerms).toContain("status = 'active'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the grant", () => {
  const NOW = 1_790_000_000_000;

  it("is bound to its shop and lives 30 minutes", async () => {
    const minted = await mintPreviewGrant(env, "pv-unit-a", NOW);
    expect(minted).not.toBeNull();
    const grant = minted?.grant ?? "";
    expect(grant).toMatch(/^v1\.\d{13}\.[A-Za-z0-9_-]{43}$/);
    expect(minted?.expiresAt).toBe(NOW + PREVIEW_GRANT_TTL_MS);
    expect(grant).not.toContain("pv-unit-a");

    expect(await verifyPreviewGrant(env, "pv-unit-a", grant, NOW)).toBe(true);
    expect(await verifyPreviewGrant(env, "pv-unit-a", grant, NOW + PREVIEW_GRANT_TTL_MS - 1)).toBe(true);
    expect(await verifyPreviewGrant(env, "pv-unit-a", grant, NOW + PREVIEW_GRANT_TTL_MS)).toBe(false);
    expect(await verifyPreviewGrant(env, "pv-unit-a", grant, NOW + PREVIEW_GRANT_TTL_MS + 1)).toBe(false);
    expect(await verifyPreviewGrant(env, "pv-unit-b", grant, NOW)).toBe(false);
  });

  it("refuses a malformed, tampered or far-future grant", async () => {
    const grant = (await mintPreviewGrant(env, "pv-unit-a", NOW))?.grant ?? "";
    const [version, expiry, signature] = grant.split(".") as [string, string, string];
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    const malformed = [
      "",
      "garbage",
      `v2.${expiry}.${signature}`,
      `${version}.${expiry}`,
      `${version}.${expiry}.${signature}=`,
      `${version}.${expiry}.${signature}.x`,
      ` ${grant}`,
      `${grant} `,
      `${version}.0${expiry}.${signature}`,
      `${version}.${expiry}.${flipped}`,
      // The signature of another expiry: the expiry is inside the signed text.
      `${version}.${Number(expiry) - 1}.${signature}`,
    ];
    for (const candidate of malformed) {
      expect(await verifyPreviewGrant(env, "pv-unit-a", candidate, NOW), candidate).toBe(false);
    }
    expect(await verifyPreviewGrant(env, "pv-unit-a", null, NOW)).toBe(false);
    // Minted for a later "now": its expiry lies more than one lifetime ahead.
    const later = (await mintPreviewGrant(env, "pv-unit-a", NOW + 60 * 60 * 1_000))?.grant ?? "";
    expect(await verifyPreviewGrant(env, "pv-unit-a", later, NOW)).toBe(false);
  });

  it("is signed with a key of its own purpose, derived from the auth secret; no secret, no grant", async () => {
    // The same text signed with the RAW secret (the bytes Better Auth uses) is refused.
    const secret = env.BETTER_AUTH_SECRET as string;
    const raw = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const expiresAt = NOW + 60_000;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        raw,
        new TextEncoder().encode(`storefront-preview/v1\npv-unit-a\n${expiresAt}`),
      ),
    );
    const rawGrant = `v1.${expiresAt}.${btoa(String.fromCharCode(...signature))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")}`;
    expect(await verifyPreviewGrant(env, "pv-unit-a", rawGrant, NOW)).toBe(false);

    const grant = (await mintPreviewGrant(env, "pv-unit-a", NOW))?.grant ?? "";
    for (const value of [undefined, "too-short"]) {
      const unconfigured = { ...env, BETTER_AUTH_SECRET: value } as Env;
      expect(await mintPreviewGrant(unconfigured, "pv-unit-a", NOW)).toBeNull();
      expect(await verifyPreviewGrant(unconfigured, "pv-unit-a", grant, NOW)).toBe(false);
    }
    // Another secret: every grant of the old one ends.
    const rotated = { ...env, BETTER_AUTH_SECRET: `${secret}-rotated` } as Env;
    expect(await verifyPreviewGrant(rotated, "pv-unit-a", grant, NOW)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The slice: two shops through the real routes, A unpublished after its
// catalogue, a paid order and an open checkout were made.

let world: SliceWorld;
let shopA: Tenant;
let shopB: Tenant;
let mug: string;
let hidden: string;
let takenDown: string;
let paid: PaidOrder;
let openCheckoutIds: [string, string];
let grantA: string;
let grantB: string;

interface Answer {
  body: string;
  cacheControl: string | null;
  etag: string | null;
  robots: string | null;
  status: number;
}

async function read(response: Response): Promise<Answer> {
  return {
    body: await response.text(),
    cacheControl: response.headers.get("cache-control"),
    etag: response.headers.get("etag"),
    robots: response.headers.get("x-robots-tag"),
    status: response.status,
  };
}

function storefrontGet(tenant: Tenant, path: string, grant?: string, headers: Record<string, string> = {}) {
  return call(world, "GET", `${tenant.origin}${path}`, {
    headers: grant === undefined ? headers : { ...headers, [PREVIEW_HEADER]: grant },
  });
}

function previewCall(tenant: Tenant, options: CallOptions = {}) {
  return call(world, "POST", `${ADMIN}/v1/admin/preview`, {
    cookie: tenant.adminCookie,
    shopId: tenant.tenantId,
    ...options,
  });
}

async function mintThroughRoute(tenant: Tenant): Promise<string> {
  const body = await expectJson<{ preview: { expiresAt: string; grant: string } }>(
    await previewCall(tenant),
    200,
    `grant for ${tenant.tenantId}`,
  );
  return body.preview.grant;
}

/** Every public read of the storefront that an unpublished shop answers with 404 (or an empty list). */
function readPaths(): string[] {
  return [
    "/v1/storefront",
    "/v1/products",
    `/v1/products/${mug}`,
    "/v1/collections",
    "/v1/collections/favoriter",
    "/v1/pages",
    "/v1/pages/om-oss",
    "/v1/legal",
    "/v1/legal/kopvillkor",
    "/v1/legal/angerratt-och-returer",
    `/v1/seo?path=${encodeURIComponent("/")}`,
    `/v1/seo?path=${encodeURIComponent(`/product/${mug}`)}`,
    `/v1/seo?path=${encodeURIComponent("/samling/favoriter")}`,
    `/v1/seo?path=${encodeURIComponent("/om-oss")}`,
  ];
}

const published = new Map<string, Answer>();

beforeAll(async () => {
  world = new SliceWorld();
  await bootstrapPlatform(world);
  shopA = await createTenant(world, { host: "pv-a.shops.preview.test", shopName: "Butik pv-a", tenantId: "pv-a" });
  shopB = await createTenant(world, { host: "pv-b.shops.preview.test", shopName: "Butik pv-b", tenantId: "pv-b" });

  mug = await createPlainProduct(world, shopA, { name: "Mugg", priceMinor: 14_900, sku: "PV-MUG" });
  await publishProduct(world, shopA, mug);
  await approveProduct(world, mug);
  // Product-level terms a preview must keep: not published, taken down.
  hidden = await seedCatalogueProduct(shopA.tenantId, { name: "Utkast", published: false, sku: "PV-DRAFT" });
  takenDown = await seedCatalogueProduct(shopA.tenantId, { name: "Nedtagen", sku: "PV-DOWN", takenDown: true });
  await seedCollection(shopA.tenantId, { handle: "favoriter", productIds: [mug, hidden, takenDown], title: "Favoriter" });
  await seedPage(shopA.tenantId, { content: "<p>Vi säljer muggar.</p>", slug: "om-oss", title: "Om oss" });

  paid = await buyProduct(world, shopA, mug, { deliverEmail: false });
  openCheckoutIds = [
    (await openCheckout(world, shopA, [{ productId: mug, quantity: 1 }])).checkoutId,
    (await openCheckout(world, shopA, [{ productId: mug, quantity: 1 }])).checkoutId,
  ];

  // What the shop's visitors see while it is published: the preview must equal it.
  for (const path of readPaths()) {
    published.set(path, await read(await storefrontGet(shopA, path)));
  }

  await expectJson(
    await platform(world, "POST", `/v1/platform/tenants/${shopA.tenantId}/unpublish`),
    200,
    "unpublish A",
  );
  await expectJson(
    await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/unpublish`),
    200,
    "unpublish B",
  );
  grantA = await mintThroughRoute(shopA);
  grantB = await mintThroughRoute(shopB);
}, 180_000);

// ═══════════════════════════════════════════════════════════════════════════
describe("POST /v1/admin/preview", () => {
  it("anonymous, another shop's admin, a platform user without a grant, a foreign or missing origin and another method get the opaque 404", async () => {
    const audits = await auditCount();
    await expectOpaque404(await previewCall(shopA, { cookie: undefined }), "anonymous");
    await expectOpaque404(await previewCall(shopA, { cookie: shopB.adminCookie }), "B for A");
    await expectOpaque404(await previewCall(shopA, { cookie: world.platformCookie }), "platform without a grant");
    await expectOpaque404(await previewCall(shopA, { shopId: undefined }), "no X-Shop-Id");
    for (const origin of ["https://evil.test", shopA.origin, null]) {
      await expectOpaque404(await previewCall(shopA, { origin }), `origin=${origin}`);
    }
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      await expectOpaque404(
        await call(world, method, `${ADMIN}/v1/admin/preview`, { cookie: shopA.adminCookie, shopId: shopA.tenantId }),
        method,
      );
    }
    expect(await auditCount()).toBe(audits);
  });

  it("gives the shop's admin a grant of 30 minutes, audited without the grant", async () => {
    const before = Date.now();
    const body = await expectJson<{ preview: { expiresAt: string; grant: string } }>(
      await previewCall(shopA),
      200,
      "grant",
    );
    expect(Object.keys(body.preview).sort()).toEqual(["expiresAt", "grant"]);
    const expiresAt = Date.parse(body.preview.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + PREVIEW_GRANT_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + PREVIEW_GRANT_TTL_MS);
    expect(body.preview.grant.split(".")[1]).toBe(String(expiresAt));
    expect(await verifyPreviewGrant(env, shopA.tenantId, body.preview.grant, Date.now())).toBe(true);
    expect(await verifyPreviewGrant(env, shopB.tenantId, body.preview.grant, Date.now())).toBe(false);

    const [audit] = (await auditRows(shopA.tenantId, "storefront.preview_granted")).slice(-1);
    expect(audit).toMatchObject({
      actorUserId: shopA.adminUserId,
      metadata: { expiresAt: body.preview.expiresAt },
      resourceId: shopA.tenantId,
      resourceType: "tenant",
    });
    expect(JSON.stringify(audit)).not.toContain(body.preview.grant.split(".")[2]);
  });

  it("a platform user with an acting-as grant gets one, audited with that grant", async () => {
    await expectJson(
      await platform(world, "POST", `/v1/platform/tenants/${shopB.tenantId}/acting-as`, { body: { reason: "preview" } }),
      201,
      "acting-as",
    );
    const body = await expectJson<{ preview: { grant: string } }>(
      await previewCall(shopB, { cookie: world.platformCookie }),
      200,
      "acting-as grant",
    );
    expect(await verifyPreviewGrant(env, shopB.tenantId, body.preview.grant, Date.now())).toBe(true);
    const [audit] = (await auditRows(shopB.tenantId, "storefront.preview_granted")).slice(-1);
    expect(audit?.actorUserId).toBe(world.platformUserId);
    expect(audit?.metadata).toMatchObject({ actingAsGrantId: expect.any(String) });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the public reads of an unpublished shop", () => {
  it("while published, every read answered (the baseline the preview is held to)", () => {
    for (const path of readPaths()) {
      const answer = published.get(path);
      expect(answer?.status, path).toBe(200);
    }
  });

  it("without a grant: the 404 of a shop that is not public (the product list: empty)", async () => {
    for (const path of readPaths()) {
      const answer = await read(await storefrontGet(shopA, path));
      if (path === "/v1/products") {
        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.body)).toEqual({ nextCursor: null, products: [] });
      } else {
        expect(answer.status, path).toBe(404);
      }
      expect(answer.robots, path).toBeNull();
    }
  });

  it("an invalid, expired, foreign, forged or future grant is ignored: the answer is the one without a grant, byte for byte", async () => {
    const now = Date.now();
    const expired = (await mintPreviewGrant(env, shopA.tenantId, now - PREVIEW_GRANT_TTL_MS - 1_000))?.grant ?? "";
    const future = (await mintPreviewGrant(env, shopA.tenantId, now + 2 * PREVIEW_GRANT_TTL_MS))?.grant ?? "";
    const forged = `${grantA.slice(0, -2)}${grantA.endsWith("AA") ? "BB" : "AA"}`;
    const invalid = { expired, forged, future, garbage: "garbage", "shop B's": grantB, empty: "" };
    for (const path of readPaths()) {
      const bare = await read(await storefrontGet(shopA, path));
      for (const [label, grant] of Object.entries(invalid)) {
        expect(await read(await storefrontGet(shopA, path, grant)), `${label} on ${path}`).toEqual(bare);
      }
    }
    // A's grant on B's host is B's foreign grant.
    expect(await read(await storefrontGet(shopB, "/v1/storefront", grantA))).toEqual(
      await read(await storefrontGet(shopB, "/v1/storefront")),
    );
  });

  it("a valid grant reads the shop exactly as its visitors will once it is published: no-store, no ETag, noindex", async () => {
    for (const path of readPaths()) {
      const before = published.get(path) as Answer;
      const answer = await read(await storefrontGet(shopA, path, grantA));
      expect(answer.status, path).toBe(200);
      expect(answer.cacheControl, path).toBe("no-store");
      expect(answer.etag, path).toBeNull();
      expect(answer.robots, path).toBe("noindex");
      if (path.startsWith("/v1/seo")) {
        const expected = JSON.parse(before.body) as { page: Record<string, unknown> };
        expect(JSON.parse(answer.body), path).toEqual({ page: { ...expected.page, robots: "noindex" } });
      } else {
        expect(answer.body, path).toBe(before.body);
      }
    }
  });

  it("never answers a preview with a 304, whatever If-None-Match holds", async () => {
    for (const path of readPaths()) {
      const etag = published.get(path)?.etag;
      for (const ifNoneMatch of [etag ?? '"1"', "*"]) {
        const answer = await read(await storefrontGet(shopA, path, grantA, { "if-none-match": ifNoneMatch }));
        expect(answer.status, `${path} ${ifNoneMatch}`).toBe(200);
        expect(answer.body.length, path).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every product-level term: a product that is not published or is taken down stays out", async () => {
    for (const productId of [hidden, takenDown]) {
      expect((await storefrontGet(shopA, `/v1/products/${productId}`, grantA)).status, productId).toBe(404);
    }
    const list = await expectJson<{ products: Array<{ productId: string }> }>(
      await storefrontGet(shopA, "/v1/products", grantA),
      200,
      "list",
    );
    expect(list.products.map((product) => product.productId)).toEqual([mug]);
    const collection = await expectJson<{ products: Array<{ productId: string }> }>(
      await storefrontGet(shopA, "/v1/collections/favoriter", grantA),
      200,
      "collection",
    );
    expect(collection.products.map((product) => product.productId)).toEqual([mug]);
  });

  it("keeps `tenant.status = 'active'`: a suspended shop is a 404 with a valid grant", async () => {
    for (const status of ["suspended", "closed", "provisioning"] as const) {
      const shop = await seedShop(`pv-${status}`, { published: false, status });
      await seedCatalogueProduct(shop.tenantId, { name: "Vara", sku: `PV-${status}` });
      const grant = (await mintPreviewGrant(env, shop.tenantId, Date.now()))?.grant ?? "";
      for (const path of ["/v1/storefront", "/v1/products", "/v1/legal", "/v1/pages"]) {
        const bare = await read(await exports.default.fetch(`${shop.origin}${path}`));
        const previewed = await read(
          await exports.default.fetch(new Request(`${shop.origin}${path}`, { headers: { [PREVIEW_HEADER]: grant } })),
        );
        expect(previewed.status, `${status} ${path}`).toBe(404);
        expect(previewed, `${status} ${path}`).toEqual(bare);
      }
    }
  });

  it("the sitemap is for search engines and ignores the grant", async () => {
    const bare = await read(await storefrontGet(shopA, "/v1/sitemap"));
    expect(bare.status).toBe(404);
    expect(await read(await storefrontGet(shopA, "/v1/sitemap", grantA))).toEqual(bare);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("a preview never sells: every write ignores the grant", () => {
  const withGrant = (options: CallOptions = {}): CallOptions => ({
    ...options,
    headers: { ...options.headers, [PREVIEW_HEADER]: grantA },
  });

  async function checkoutCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM checkouts WHERE tenant_id = ?")
      .bind(shopA.tenantId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  function checkoutBody() {
    return {
      consent: { terms: true },
      deliveryMethod: "pickup",
      email: `${unique("buyer")}@buyers.preview.test`,
      idempotencyKey: unique("idem-preview"),
      items: [{ productId: mug, quantity: 1 }],
      recipient: SLICE_RECIPIENT,
    };
  }

  it("checkout: refused with the grant exactly as without, and no checkout is made", async () => {
    const before = await checkoutCount();
    const bare = await read(
      await call(world, "POST", `${shopA.origin}/v1/checkout`, { body: checkoutBody(), origin: null }),
    );
    const previewed = await read(
      await call(world, "POST", `${shopA.origin}/v1/checkout`, withGrant({ body: checkoutBody(), origin: null })),
    );
    expect(bare.status).toBeGreaterThanOrEqual(400);
    expect(previewed).toEqual(bare);
    expect(await checkoutCount()).toBe(before);
  });

  it("payment: refused with the grant exactly as without", async () => {
    const intents = world.stripe.intents.size;
    const unknown = "00000000-0000-4000-8000-000000000000";
    const previewed = await read(
      await call(world, "POST", `${shopA.origin}/v1/checkout/${unknown}/payment`, withGrant({ origin: null })),
    );
    const bare = await read(await paymentCall(world, shopA, unknown));
    expect(bare.status).toBe(404);
    expect(previewed).toEqual(bare);
    expect(world.stripe.intents.size).toBe(intents);
  });

  // FOUND, NOT CHANGED (CP4_D2_REPORT.md, open point 1): a checkout OPENED
  // while the shop was published can still be paid after it is unpublished;
  // the payment route re-reads the checkout, not the shop's publication. That
  // is the route as it was before the preview. What is proven here is only
  // that the grant changes nothing about it: the two checkouts, one paid with
  // the grant and one without, get the same answer.
  it("payment of a checkout opened while live: the grant changes nothing", async () => {
    const [first, second] = openCheckoutIds;
    const previewed = await call(
      world,
      "POST",
      `${shopA.origin}/v1/checkout/${first}/payment`,
      withGrant({ origin: null }),
    );
    const bare = await paymentCall(world, shopA, second);
    expect(previewed.status).toBe(bare.status);
    const shape = (body: unknown) => JSON.stringify(body, (_key, value) => (typeof value === "string" ? "s" : value));
    expect(shape(await previewed.json())).toBe(shape(await bare.json()));
    expect(previewed.headers.get("x-robots-tag")).toBeNull();
  });

  it("the receipt and the order: the grant changes nothing", async () => {
    const claimed = await expectJson<{ receipt: { receiptToken?: string; status: string } }>(
      await claimReceipt(world, shopA, paid.checkoutId),
      200,
      "first claim",
    );
    const previewedClaim = await read(
      await call(world, "POST", `${shopA.origin}/v1/checkout/${paid.checkoutId}/receipt`, withGrant({ origin: null })),
    );
    const bareClaim = await read(await claimReceipt(world, shopA, paid.checkoutId));
    expect(previewedClaim).toEqual(bareClaim);

    const token = JSON.stringify(claimed).match(/"receiptToken":"([^"]+)"/)?.[1] ?? "no-token";
    const bareOrder = await read(await readBuyerOrder(world, shopA, paid.orderId, token));
    const previewedOrder = await read(
      await call(world, "GET", `${shopA.origin}/v1/orders/${paid.orderId}`, withGrant({ bearer: token })),
    );
    expect(previewedOrder).toEqual(bareOrder);
    // Without the token the grant opens nothing either.
    const noToken = await read(
      await call(world, "GET", `${shopA.origin}/v1/orders/${paid.orderId}`, withGrant()),
    );
    expect(noToken.status).toBe(404);
  });

  it("withdrawal: refused with the grant exactly as without", async () => {
    const order = await env.DB.prepare("SELECT order_number FROM orders WHERE order_id = ?")
      .bind(paid.orderId)
      .first<{ order_number: string }>();
    const payload = {
      orderNumber: order?.order_number ?? "",
      statement: { contactEmail: "someone-else@preview.test", name: "Någon Annan" },
    };
    const bare = await read(await call(world, "POST", `${shopA.origin}/v1/withdrawals`, { body: payload, origin: null }));
    const previewed = await read(
      await call(world, "POST", `${shopA.origin}/v1/withdrawals`, withGrant({ body: payload, origin: null })),
    );
    expect(bare.status).toBe(404);
    expect(previewed).toEqual(bare);
  });

  it("report: answered with the grant as without (the intake never asked whether the shop is published)", async () => {
    const payload = (name: string) => ({
      attestation: true,
      description: "Mitt varumärke används utan lov.",
      productId: mug,
      reporterEmail: "rights@preview.test",
      reporterName: name,
      rightType: "trademark",
      website: "",
    });
    const bare = await call(world, "POST", `${shopA.origin}/v1/reports`, { body: payload("Utan"), origin: null });
    const previewed = await call(
      world,
      "POST",
      `${shopA.origin}/v1/reports`,
      withGrant({ body: payload("Med"), origin: null }),
    );
    expect(previewed.status).toBe(bare.status);
    const [bareBody, previewedBody] = [await bare.json<object>(), await previewed.json<object>()];
    expect(JSON.stringify(Object.keys(previewedBody))).toBe(JSON.stringify(Object.keys(bareBody)));
    expect(previewed.headers.get("x-robots-tag")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the POD preview image of an unpublished shop", () => {
  const TENANT = "pv-pod";
  const HOST = "pv-pod.podtest.test";
  const URL_PATH = `https://${HOST}/v1/storefront/pod-previews/pv-tee/pv-art`;

  beforeAll(async () => {
    await seedPodTenant(TENANT, HOST);
    await seedProfile();
    await seedPrinter();
    await seedArtwork(TENANT, { artworkId: "pv-art" });
    // Past D8's first-N (test/screening.test.ts owns that rule): two live products.
    await seedPodProduct(TENANT, { productId: "pv-live-1", published: true });
    await seedPodProduct(TENANT, { productId: "pv-live-2", published: true });
    await seedPodProduct(TENANT, { isPod: true, priceMinor: 39_900, productId: "pv-tee" });
    const mapped = await createMapping(
      env.DB,
      adminOf(TENANT),
      { artworkId: "pv-art", printerId: "fake-printer", productId: "pv-tee", slots: ["front"], sku: TEE_S, variantId: null },
      Date.now(),
    );
    expect(mapped.status).toBe("ok");
    expect((await publishAdminProduct(env.DB, adminOf(TENANT), "pv-tee", Date.now())).status).toBe("ok");
    expect((await exports.default.fetch(URL_PATH)).status).toBe(200);
    await env.DB.prepare("UPDATE tenants SET published = 0 WHERE tenant_id = ?").bind(TENANT).run();
  });

  it("is a 404 without a grant and with an invalid one, and the image with a valid one: no-store, no ETag, noindex", async () => {
    const bare = await read(await exports.default.fetch(URL_PATH));
    expect(bare.status).toBe(404);
    const foreign = (await mintPreviewGrant(env, "pv-a", Date.now()))?.grant ?? "";
    for (const grant of ["garbage", foreign]) {
      expect(
        await read(await exports.default.fetch(new Request(URL_PATH, { headers: { [PREVIEW_HEADER]: grant } }))),
        grant,
      ).toEqual(bare);
    }

    const grant = (await mintPreviewGrant(env, TENANT, Date.now()))?.grant ?? "";
    const response = await exports.default.fetch(
      new Request(URL_PATH, { headers: { [PREVIEW_HEADER]: grant, "if-none-match": "*" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PREVIEW_BYTES);
  });
});
