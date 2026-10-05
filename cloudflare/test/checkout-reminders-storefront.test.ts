import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { takesDestinationCharges } from "../src/commerce/payment";
import { adminFeatures } from "../src/routes/admin-session";
import { STOREFRONT_BODY_REVISION } from "../src/storefront/public-routes";
import { ordersOpenOf, PORTED_FEATURE_KEYS, shopTakesOrders } from "../src/storefront/public-storefront";
import { nextId, seedReminderShop, setAddOn, setSellerSwitch } from "./reminder-fixtures";

/**
 * CP9-AC build step 9 (D81 reversed for `abandonedCheckout` only): the
 * storefront's feature is the add-on AND the seller's switch, a switch change
 * never meets a stale 304, the admin's feature is the add-on alone, and
 * `ordersOpen` is computed exactly as before.
 */

async function storefront(host: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(new Request(`https://${host}/v1/storefront`, { headers }));
}

async function featureOf(host: string): Promise<boolean> {
  const body = await (await storefront(host)).json<{ storefront: { features: Record<string, boolean> } }>();
  return body.storefront.features.abandonedCheckout as boolean;
}

describe("features.abandonedCheckout = ported AND the add-on AND the seller's switch", () => {
  it.each([
    ["no add-on row (opt-in), switch on", null, true, false],
    ["add-on off, switch on", false, true, false],
    ["add-on on, no switch row", true, null, false],
    ["add-on on, switch off", true, false, false],
    ["add-on on, switch on", true, true, true],
  ] as const)("%s → %s", async (_label, addOn, seller, expected) => {
    const tenantId = nextId("acsf").toLowerCase();
    const { host } = await seedReminderShop(tenantId, {
      addOn,
      seller: seller === null ? null : { enabled: seller, enabledAt: seller ? 1 : null },
    });
    expect(await featureOf(host)).toBe(expected);
  });

  it("is ported, and the body revision is 3", () => {
    expect(PORTED_FEATURE_KEYS).toContain("abandonedCheckout");
    expect(STOREFRONT_BODY_REVISION).toBe(3);
  });

  it("a switch change (and an add-on change) bumps the version: never a stale 304", async () => {
    const tenantId = nextId("acsf-etag").toLowerCase();
    const { host } = await seedReminderShop(tenantId, { addOn: true, seller: { enabled: false, enabledAt: null } });
    const first = await storefront(host);
    const etag = first.headers.get("etag") as string;
    expect(etag).toMatch(new RegExp(`^"\\d+-r${STOREFRONT_BODY_REVISION}"$`));
    expect((await storefront(host, { "if-none-match": etag })).status).toBe(304);
    await setSellerSwitch(tenantId, { enabled: true, enabledAt: 1 });
    const changed = await storefront(host, { "if-none-match": etag });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { storefront: { features: { abandonedCheckout: boolean } } }).storefront.features.abandonedCheckout).toBe(true);
    const next = (await storefront(host)).headers.get("etag") as string;
    await setAddOn(tenantId, false);
    expect((await storefront(host, { "if-none-match": next })).status).toBe(200);
    expect(await featureOf(host)).toBe(false);
  });
});

describe("the admin's feature is the add-on alone (the card shows while the platform allows it)", () => {
  it("is true for an explicit ON, false for none or OFF", () => {
    expect(adminFeatures([{ enabled: true, key: "abandonedCheckout" }]).abandonedCheckout).toBe(true);
    expect(adminFeatures([{ enabled: false, key: "abandonedCheckout" }]).abandonedCheckout).toBe(false);
  });
});

describe("ordersOpen, unchanged", () => {
  it("ordersOpenOf is exactly the expression it replaced, in every case", () => {
    const accounts = [
      null,
      { stripe_account_id: null, stripe_charges_enabled: 0 },
      { stripe_account_id: null, stripe_charges_enabled: 1 },
      { stripe_account_id: "acct_1", stripe_charges_enabled: 0 },
      { stripe_account_id: "acct_1", stripe_charges_enabled: 1 },
    ];
    for (const legallyOpen of [false, true]) {
      for (const account of accounts) {
        const before = legallyOpen && account !== null && takesDestinationCharges(account);
        expect(ordersOpenOf(legallyOpen, account), JSON.stringify({ account, legallyOpen })).toBe(before);
      }
    }
  });

  it("shopTakesOrders adds the public-shop gate to it (the cron's check 4)", async () => {
    const tenantId = nextId("acsf-orders").toLowerCase();
    await seedReminderShop(tenantId);
    expect(await shopTakesOrders(env.DB, tenantId, Date.now())).toBe(true);
    await env.DB.prepare("UPDATE tenants SET published = 0 WHERE tenant_id = ?").bind(tenantId).run();
    expect(await shopTakesOrders(env.DB, tenantId, Date.now())).toBe(false);
    await env.DB.prepare("UPDATE tenants SET published = 1, stripe_charges_enabled = 0 WHERE tenant_id = ?").bind(tenantId).run();
    expect(await shopTakesOrders(env.DB, tenantId, Date.now())).toBe(false);
  });
});
