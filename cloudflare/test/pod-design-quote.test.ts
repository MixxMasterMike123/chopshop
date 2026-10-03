import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createMapping, designQuote } from "../src/pod/pod-mappings";
import { podPriceFloorMinor, quotePodCost } from "../src/pod/pod-quote";
import { replacePrinters } from "../src/pod/printers";
import {
  adminOf,
  CAP,
  expectHandHidden,
  grantActingAs,
  grantPlatformAdmin,
  grantTenantAdmin,
  hiddenPrinter,
  OPAQUE_NOT_FOUND,
  PLATFORM,
  type PlatformSecrets,
  secretsOf,
  SEED_NOW,
  seedArtwork,
  seedProduct,
  seedProfile,
  seedTenant,
  sessionRequest,
  signUp,
  TEE_M,
  TEE_S,
  testCapabilities,
} from "./pod-fixtures";

/**
 * CP5-WG (a): GET /v1/admin/pod/design-quote?printerId=&sku=&slots= — the
 * seller's Inköp and price floor for a CHOICE made before any product or
 * mapping exists. Refusals first, then the one-formula proof (the design
 * quote equals the product quote of a product mapped to the same choice),
 * then the one-number walk over every answer.
 */

const TENANT_A = "tenant-dq-a";
const TENANT_B = "tenant-dq-b";
const TENANT_EUR = "tenant-dq-eur";
const HOST = "https://admin.dqtest.test";
const A = adminOf(TENANT_A);
/** Listed in the printer's catalogue, with no price row. */
const UNPRICED_SKU = "2700005";

let tenantAdmin: { cookie: string; userId: string };
let eurAdmin: { cookie: string; userId: string };
let platform: { cookie: string; userId: string };
let secrets: PlatformSecrets;

type Caller = "acting" | "anonymous" | "eur" | "tenant" | "tenant-bare" | "tenant-foreign";

function call(caller: Caller, query: string, method = "GET"): Promise<Response> {
  const url = `${HOST}/v1/admin/pod/design-quote${query}`;
  if (caller === "anonymous") {
    return exports.default.fetch(new Request(url, { headers: { "x-shop-id": TENANT_A }, method }));
  }
  const cookie =
    caller === "acting" ? platform.cookie : caller === "eur" ? eurAdmin.cookie : tenantAdmin.cookie;
  const shopId =
    caller === "tenant-bare"
      ? undefined
      : caller === "tenant-foreign"
        ? TENANT_B
        : caller === "eur"
          ? TENANT_EUR
          : TENANT_A;
  return exports.default.fetch(
    sessionRequest(url, method, { cookie, ...(shopId === undefined ? {} : { shopId }) }),
  );
}

const q = (printerId: string, sku: string, slots: string) =>
  `?printerId=${encodeURIComponent(printerId)}&sku=${encodeURIComponent(sku)}&slots=${encodeURIComponent(slots)}`;

async function insertPrinter(id: string, tenantId: string | null, status: "active" | "inactive"): Promise<void> {
  const iso = new Date(SEED_NOW).toISOString();
  await env.DB.prepare(
    `INSERT INTO printers (id, tenant_id, type, name, status, currency, shipping_cost_minor,
       capabilities_json, created_at, updated_at)
     VALUES (?, ?, 'manual', ?, ?, 'SEK', 4900, ?, ?, ?)`,
  )
    .bind(id, tenantId, `Printer ${id}`, status, JSON.stringify(testCapabilities()), iso, iso)
    .run();
  await env.DB.prepare(
    `INSERT INTO printer_sku_tiers (printer_id, tenant_id, sku, blank_cost_minor, print_costs_json, created_at, updated_at)
     VALUES (?, ?, ?, 6000, '{"front":4000}', ?, ?)`,
  )
    .bind(id, tenantId, TEE_S, iso, iso)
    .run();
}

beforeAll(async () => {
  await seedTenant(TENANT_A, "dq-a.dqtest.test");
  await seedTenant(TENANT_B, "dq-b.dqtest.test");
  await seedTenant(TENANT_EUR, "dq-eur.dqtest.test");
  await env.DB.prepare("UPDATE tenants SET default_currency = 'EUR' WHERE tenant_id = ?").bind(TENANT_EUR).run();
  await seedProfile();

  // The platform printer with DISTINCTIVE hidden figures, plus one listed SKU
  // without a price row (so the `unpriced` path is reachable).
  const capabilities = testCapabilities();
  capabilities.skus[UNPRICED_SKU] = { label: "White / L", model: "2000" };
  expect(await replacePrinters(env.DB, PLATFORM, [hiddenPrinter({ capabilities })], Date.now())).not.toBeNull();
  secrets = secretsOf([hiddenPrinter()]);

  // A printer another shop owns, and a platform printer that is switched off.
  await insertPrinter("b-own", TENANT_B, "active");
  await insertPrinter("switched-off", null, "inactive");

  await seedArtwork(TENANT_A, { artworkId: "dq-art" });

  tenantAdmin = await signUp("dq-admin@dqtest.test");
  await grantTenantAdmin(tenantAdmin.userId, TENANT_A);
  eurAdmin = await signUp("dq-eur@dqtest.test");
  await grantTenantAdmin(eurAdmin.userId, TENANT_EUR);
  platform = await signUp("dq-platform@dqtest.test");
  await grantPlatformAdmin(platform.userId);
  await grantActingAs(platform.userId, TENANT_A);
});

describe("refusals", () => {
  it("no session, a session without X-Shop-Id, and a foreign shop: the opaque 404", async () => {
    for (const caller of ["anonymous", "tenant-bare", "tenant-foreign"] as const) {
      const response = await call(caller, q("fake-printer", TEE_S, "front"));
      expect(response.status, caller).toBe(404);
      expect(await response.json()).toStrictEqual(OPAQUE_NOT_FOUND);
    }
  });

  it("every method but GET is the opaque 404", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await call("tenant", q("fake-printer", TEE_S, "front"), method);
      expect(response.status, method).toBe(404);
    }
  });

  it.each([
    ["nothing", ""],
    ["no printerId", `?sku=${TEE_S}&slots=front`],
    ["no sku", "?printerId=fake-printer&slots=front"],
    ["no slots", `?printerId=fake-printer&sku=${TEE_S}`],
    ["an empty slot list", q("fake-printer", TEE_S, "")],
    ["a trailing comma", q("fake-printer", TEE_S, "front,")],
    ["an unknown slot", q("fake-printer", TEE_S, "chest")],
    ["a slot twice", q("fake-printer", TEE_S, "front,front")],
    ["six slots", q("fake-printer", TEE_S, "front,back,pocket,left_sleeve,right_sleeve,front")],
    ["a malformed sku", q("fake-printer", "abc!", "front")],
    ["an over-long printerId", q("p".repeat(129), TEE_S, "front")],
    ["a repeated parameter", `${q("fake-printer", TEE_S, "front")}&sku=${TEE_M}`],
    ["an unknown parameter", `${q("fake-printer", TEE_S, "front")}&quantity=2`],
    ["a productId (the other quote's input)", `${q("fake-printer", TEE_S, "front")}&productId=x`],
  ])("refuses %s with 400", async (_label, query) => {
    const response = await call("tenant", query);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it.each([
    ["an unknown printer", q("nobody", TEE_S, "front"), "printer_unavailable"],
    ["another shop's own printer", q("b-own", TEE_S, "front"), "printer_unavailable"],
    ["an inactive printer", q("switched-off", TEE_S, "front"), "printer_unavailable"],
    ["a SKU not in the printer's catalogue", q("fake-printer", "2810013", "front"), "sku_unavailable"],
    ["a slot the garment has no frame for", q("fake-printer", TEE_S, "left_sleeve"), "slot_not_printable"],
    ["a cap's back", q("fake-printer", CAP, "front,back"), "slot_not_printable"],
    // Masked: the seller is not told that a price row is what is missing…
    ["a listed SKU without a price row", q("fake-printer", UNPRICED_SKU, "front"), "sku_unavailable"],
  ])("refuses %s with 422 %s", async (_label, query, code) => {
    const response = await call("tenant", query);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toStrictEqual({ error: { code, message: "This choice cannot be produced" } });
    expectHandHidden(body, secrets);
  });

  it("…nor that the printer prices in another currency than the shop", async () => {
    const response = await call("eur", q("fake-printer", TEE_S, "front"));
    expect(response.status).toBe(422);
    expect(await response.json()).toStrictEqual({
      error: { code: "printer_unavailable", message: "This choice cannot be produced" },
    });
    // The precise codes stay in the function, for the platform's own use.
    await expect(
      designQuote(env.DB, adminOf(TENANT_EUR), { printerId: "fake-printer", sku: TEE_S, slots: ["front"] }),
    ).resolves.toStrictEqual({ code: "currency_mismatch", status: "refused" });
    await expect(
      designQuote(env.DB, A, { printerId: "fake-printer", sku: UNPRICED_SKU, slots: ["front"] }),
    ).resolves.toStrictEqual({ code: "unpriced", status: "refused" });
  });
});

describe("one formula", () => {
  let n = 0;
  const next = (prefix: string) => `${prefix}-${(n += 1)}`;

  async function mappedQuote(sku: string, slots: Array<"back" | "front" | "pocket">): Promise<unknown> {
    const productId = next("dq-product");
    await seedProduct(TENANT_A, { productId });
    for (const slot of slots) {
      const artworkId = next("dq-art-slot");
      await seedArtwork(TENANT_A, { artworkId });
      const created = await createMapping(
        env.DB,
        A,
        { artworkId, printerId: "fake-printer", productId, sku, slots: [slot], variantId: null },
        Date.now(),
      );
      expect(created.status).toBe("ok");
    }
    const response = await exports.default.fetch(
      sessionRequest(`${HOST}/v1/admin/pod/quote?productId=${productId}`, "GET", {
        cookie: tenantAdmin.cookie,
        shopId: TENANT_A,
      }),
    );
    expect(response.status).toBe(200);
    return response.json();
  }

  it.each([
    [TEE_S, ["front"]],
    [TEE_S, ["front", "back"]],
    [TEE_M, ["back", "pocket"]],
    [CAP, ["front"]],
  ] as Array<[string, Array<"back" | "front" | "pocket">]>)(
    "the design quote of %s %j equals the quote of a product mapped to the same choice",
    async (sku, slots) => {
      const design = await call("tenant", q("fake-printer", sku, slots.join(",")));
      expect(design.status).toBe(200);
      const designBody = await design.json();
      expect(designBody).toStrictEqual(await mappedQuote(sku, slots));
    },
  );

  it("follows the shop's VAT exactly as the product quote does (D41 floor, parcel included)", async () => {
    await env.DB.prepare("UPDATE tenants SET vat_rate_bp = 3000 WHERE tenant_id = ?").bind(TENANT_A).run();
    try {
      const design = await (await call("tenant", q("fake-printer", TEE_S, "front,back"))).json();
      expect(design).toStrictEqual(await mappedQuote(TEE_S, ["front", "back"]));
      // And both are the server-only formula over the hidden figures:
      // 71.37 blank + 62.11 + 62.23 prints + 40 cut, floored with the 69.57 parcel.
      const quote = await quotePodCost(env.DB, { printerId: "fake-printer", quantity: 1, sku: TEE_S, slots: ["front", "back"] });
      expect(quote).not.toBeNull();
      expect(design).toStrictEqual({
        currency: "SEK",
        inkopMinor: 7_137 + 6_211 + 6_223 + 4_000,
        priceFloorMinor: quote === null ? -1 : podPriceFloorMinor(quote, 3_000),
      });
    } finally {
      await env.DB.prepare("UPDATE tenants SET vat_rate_bp = 2500 WHERE tenant_id = ?").bind(TENANT_A).run();
    }
  });

  it("slot order does not change the answer", async () => {
    const one = await (await call("tenant", q("fake-printer", TEE_S, "front,back"))).json();
    const two = await (await call("tenant", q("fake-printer", TEE_S, "back,front"))).json();
    expect(two).toStrictEqual(one);
  });
});

describe("the one-number walk", () => {
  it.each(["tenant", "acting"] as const)("every answer a %s session gets carries nothing but the one number and the floor", async (caller) => {
    const ok = await call(caller, q("fake-printer", TEE_S, "front"));
    expect(ok.status).toBe(200);
    const body: unknown = await ok.json();
    expect(Object.keys(body as object).sort()).toStrictEqual(["currency", "inkopMinor", "priceFloorMinor"]);
    expectHandHidden(body, secrets);

    for (const [query, status] of [
      [q("nobody", TEE_S, "front"), 422],
      [q("b-own", TEE_S, "front"), 422],
      [q("fake-printer", "2810013", "front"), 422],
      [q("fake-printer", UNPRICED_SKU, "front"), 422],
      [q("fake-printer", TEE_S, "left_sleeve"), 422],
      [q("fake-printer", TEE_S, "front,front"), 400],
      ["", 400],
    ] as Array<[string, number]>) {
      const response = await call(caller, query);
      expect(response.status, query).toBe(status);
      expectHandHidden(await response.json(), secrets);
    }
  });
});
