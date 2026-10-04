import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ADMIN, call, createPlainProduct } from "./slice-harness";
import { expectJson, expectOpaque404, SliceWorld, type Tenant, tenantWorld } from "./tenant-fixtures";

/**
 * CP5-WK — a product create or update refused for the HTML of "Mer
 * information" names the field and why (as a refused legal text names its
 * page), with the code still `invalid_request`. The shape is judged first:
 * any other fault answers the plain invalid_request.
 */

const PLAIN = { error: { code: "invalid_request", message: "Request is not valid" } };

function named(reason: string) {
  return {
    error: {
      code: "invalid_request",
      field: "moreInfo",
      message: "A text holds markup that cannot be published",
      reason,
    },
  };
}

let world: SliceWorld;
let shop: Tenant;
let productId = "";

function admin(method: string, path: string, body: unknown, cookie = shop.adminCookie): Promise<Response> {
  return call(world, method, `${ADMIN}${path}`, { body, cookie, shopId: shop.tenantId });
}

async function stored(): Promise<unknown> {
  return env.DB.prepare("SELECT more_info, updated_at FROM products WHERE product_id = ?").bind(productId).first();
}

async function productCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE tenant_id = ?")
    .bind(shop.tenantId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

beforeAll(async () => {
  const setup = await tenantWorld("wkmi", 1);
  world = setup.world;
  [shop] = setup.tenants as [Tenant];
  productId = await createPlainProduct(world, shop, { name: "Mugg", priceMinor: 19_900, sku: "WKMI-1" });
}, 120_000);

beforeEach(() => {
  world.reset();
});

describe("PATCH /v1/admin/products/:id", () => {
  it.each([
    ["script", "<p>Info</p><script>alert(1)</script>"],
    ["event_attribute", '<p onclick="x()">Info</p>'],
    ["javascript_url", '<a href="javascript:alert(1)">x</a>'],
  ])("names moreInfo and the reason (%s), writing nothing", async (reason, html) => {
    const before = await stored();
    expect(await expectJson(await admin("PATCH", `/v1/admin/products/${productId}`, { moreInfo: html, name: "Ny" }), 400, reason)).toEqual(
      named(reason),
    );
    expect(await stored()).toEqual(before);
  });

  it.each([
    ["another field is also wrong", { isPersonalized: true, moreInfo: "<script>x</script>" }],
    ["moreInfo is over its length", { moreInfo: `<script>x</script>${"m".repeat(20_000)}` }],
    ["moreInfo holds a control character", { moreInfo: "<script>x</script>\u0000" }],
    ["moreInfo is not text", { moreInfo: ["<script>x</script>"] }],
    ["an unknown key besides", { handle: "chosen", moreInfo: "<script>x</script>" }],
  ])("the shape first: %s → the plain invalid_request", async (_label, body) => {
    expect(await expectJson(await admin("PATCH", `/v1/admin/products/${productId}`, body), 400, "plain")).toEqual(PLAIN);
  });

  it("accepted HTML is still written", async () => {
    await expectJson(await admin("PATCH", `/v1/admin/products/${productId}`, { moreInfo: "<p>Mer <b>info</b></p>" }), 200, "ok");
    expect(await stored()).toMatchObject({ more_info: "<p>Mer <b>info</b></p>" });
  });

  it("the guard comes before the body: anonymous and cross-origin are the opaque 404", async () => {
    await expectOpaque404(
      await call(world, "PATCH", `${ADMIN}/v1/admin/products/${productId}`, {
        body: { moreInfo: "<script>x</script>" },
        shopId: shop.tenantId,
      }),
      "anonymous",
    );
    await expectOpaque404(
      await call(world, "PATCH", `${ADMIN}/v1/admin/products/${productId}`, {
        body: { moreInfo: "<script>x</script>" },
        cookie: shop.adminCookie,
        origin: "https://evil.test",
        shopId: shop.tenantId,
      }),
      "cross-origin",
    );
  });
});

describe("POST /v1/admin/products", () => {
  const valid = { currency: "SEK", name: "Tallrik", priceMinor: 9_900, sku: "WKMI-NEW" };

  it("names moreInfo on a create whose only fault is its HTML, creating nothing", async () => {
    const before = await productCount();
    expect(
      await expectJson(await admin("POST", "/v1/admin/products", { ...valid, moreInfo: "<script>x</script>" }), 400, "create"),
    ).toEqual(named("script"));
    expect(await productCount()).toBe(before);
  });

  it("a create missing a required field is the plain invalid_request, refused HTML or not", async () => {
    const { sku: _sku, ...noSku } = valid;
    expect(await expectJson(await admin("POST", "/v1/admin/products", { ...noSku, moreInfo: "<script>x</script>" }), 400, "no sku")).toEqual(
      PLAIN,
    );
    expect(await expectJson(await admin("POST", "/v1/admin/products", "not an object"), 400, "not an object")).toEqual(PLAIN);
  });
});
