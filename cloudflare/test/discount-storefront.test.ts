import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { STOREFRONT_BODY_REVISION } from "../src/storefront/public-routes";
import { PORTED_FEATURE_KEYS } from "../src/storefront/public-storefront";
import { catalogVersion, seedShop, setFeature, type SeededShop } from "./storefront-fixtures";

/**
 * CP8-DC build step 8: D81 reversed for `discountCodes` only (DC1), the key
 * opt-in per shop (DC2), and F10: the storefront body names its code
 * revision in its ETag, so a body a browser kept from before the deploy
 * (`discountCodes: false` whatever the shop's switch) is answered in full,
 * never with a stale 304.
 */

let shop: SeededShop;

function read(headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${shop.origin}/v1/storefront`, { headers }));
}

beforeAll(async () => {
  shop = await seedShop("tenant-dc-storefront");
});

describe("the storefront's discountCodes feature", () => {
  it("is ported, off until the platform turns it on, and follows the switch", async () => {
    expect(PORTED_FEATURE_KEYS).toContain("discountCodes");
    expect(PORTED_FEATURE_KEYS).toContain("pod");
    const features = async () => ((await (await read()).json()) as { storefront: { features: Record<string, boolean> } }).storefront.features;
    expect((await features()).discountCodes).toBe(false);
    await setFeature(shop.tenantId, "discountCodes", true);
    expect((await features()).discountCodes).toBe(true);
    await setFeature(shop.tenantId, "discountCodes", false);
    expect((await features()).discountCodes).toBe(false);
  });

  it("names the body revision in the ETag: an ETag kept from before the deploy gets the full body", async () => {
    const version = await catalogVersion(shop.tenantId);
    const fresh = await read();
    // CP9-OB: `-x`, the seeded shop cannot take an order (no account, no legal pages).
    expect(fresh.headers.get("etag")).toBe(`"${version}-r${STOREFRONT_BODY_REVISION}-x"`);
    expect(STOREFRONT_BODY_REVISION).toBeGreaterThanOrEqual(1);
    const body = await fresh.text();

    // What the code before CP8-DC answered for the same version.
    const stale = await read({ "if-none-match": `"${version}"` });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe(body);

    const current = await read({ "if-none-match": `"${version}-r${STOREFRONT_BODY_REVISION}-x"` });
    expect(current.status).toBe(304);
  });

  it("leaves every other public read's ETag as it was", async () => {
    const version = await catalogVersion(shop.tenantId);
    const products = await exports.default.fetch(new Request(`${shop.origin}/v1/products`));
    expect(products.headers.get("etag")).toBe(`"${version}"`);
  });
});
